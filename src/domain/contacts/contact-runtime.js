// Этап 49, п.2 (CONTACTS-FSM.md §3) — imperative shell: держит Map<peerPubkey,
// peerState> для ВСЕХ известных peer'ов владельца, исполняет команды reduce()/
// reconcileList() (contact-fsm.js), маршрутизирует входящие gift-wrapped rumor'ы.
// Написан Claude напрямую (интеграция с Dexie/transport.js, миграция legacy-таблиц —
// решение 13a, не рутина для воркера).

import { reduce, reconcileList } from "./contact-fsm.js";
import {
	CONTACT_REQUEST_KIND,
	buildContactRequestRumor,
	CONTACT_ACCEPTED_KIND,
	buildContactAcceptedRumor,
	CONTACT_REJECTED_KIND,
	buildContactRejectedRumor,
	ACQUAINT_CANCELLED_KIND,
	buildAcquaintCancelledRumor,
} from "./requests.js";
import { buildContactListEvent, buildMuteListEvent } from "./contacts.js";
import { wrap as nip59Wrap } from "../../core/crypto/nip59.js";
import { db } from "../../core/store/database.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

function noneState(peer) {
	return { name: "NONE", peerPubkey: peer, resolvedAt: 0, greeting: null };
}

function rowToPeerState(row, dbKey) {
	const decrypted = fromEncryptedRow(row, dbKey);
	return {
		name: decrypted.state,
		peerPubkey: decrypted.peer,
		resolvedAt: decrypted.resolvedAt ?? 0,
		greeting: decrypted.greeting ?? null,
		sentAt: decrypted.sentAt ?? null,
	};
}

function peerStateToRow(ownerPubkey, peerState, dbKey) {
	return toEncryptedRow(
		{
			owner: ownerPubkey,
			peer: peerState.peerPubkey,
			state: peerState.name,
			resolvedAt: peerState.resolvedAt ?? 0,
			sentAt: peerState.sentAt ?? null,
			greeting: peerState.greeting ?? null,
		},
		CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS,
		dbKey,
	);
}

// Развилка (этап 49, задача 3): миграция contactRequests (зашифрована, нужен dbKey)
// отложена до unlock — Dexie upgrade-транзакция (database.js, db.version(15)) не имеет
// доступа к dbKey. Идемпотентна ПО КОНСТРУКЦИИ: успешный перенос очищает исходные
// строки, повторный вызов (следующий connect() той же сессии) находит их уже пустыми
// и ничего не делает — отдельный флаг "миграция завершена" не нужен.
export async function migrateLegacyContactTables(ownerPubkey, dbKey) {
	const now = Math.floor(Date.now() / 1000);
	const rels = db.table("contactRelationships");

	const contactRows = await db.table("contacts").where("owner").equals(ownerPubkey).toArray();
	for (const row of contactRows) {
		await rels.put(peerStateToRow(ownerPubkey, { peerPubkey: row.pubkey, name: "CONTACT", resolvedAt: now, greeting: null, sentAt: null }, dbKey));
	}

	const blockedRows = await db.table("blockedContacts").where("owner").equals(ownerPubkey).toArray();
	for (const row of blockedRows) {
		await rels.put(peerStateToRow(ownerPubkey, { peerPubkey: row.pubkey, name: "BLOCKED", resolvedAt: now, greeting: null, sentAt: null }, dbKey));
	}

	// БЛОКИРОВКА приоритетнее входящей заявки (тот же принцип, что уже действующий
	// blockContactAction сегодня — "две категории взаимоисключающие, не показываются
	// одновременно"), поэтому строки contacts/blockedContacts обработаны ВЫШЕ.
	const requestRows = await db.table("contactRequests").where("owner").equals(ownerPubkey).toArray();
	for (const row of requestRows) {
		const decrypted = fromEncryptedRow(row, dbKey);
		const existingRow = await rels.get([ownerPubkey, decrypted.senderPubkey]);
		if (existingRow && fromEncryptedRow(existingRow, dbKey).state === "BLOCKED") continue;
		await rels.put(
			peerStateToRow(ownerPubkey, { peerPubkey: decrypted.senderPubkey, name: "INCOMING_PENDING", resolvedAt: 0, greeting: decrypted.greeting, sentAt: null }, dbKey),
		);
	}

	await db.transaction("rw", db.table("contacts"), db.table("blockedContacts"), db.table("contactRequests"), async () => {
		await db.table("contacts").where("owner").equals(ownerPubkey).delete();
		await db.table("blockedContacts").where("owner").equals(ownerPubkey).delete();
		await db.table("contactRequests").where("owner").equals(ownerPubkey).delete();
	});
}

// Найдено живым фидбеком пользователя — sendRequest(peer) не проверял peer !==
// ownerPubkey: заявка "самому себе" реально отправлялась и реально приходила
// (INCOMING_PENDING на собственный pubkey). Корень — не в UI (npub можно
// скопировать и вставить куда угодно, включая собственный), а в самом
// FSM-диспетчере — единственное надёжное место поймать это для ЛЮБОГО
// вызывающего (discovery.jsx/contacts.jsx уже сегодня, и любой будущий путь).
export class SelfContactRequestError extends Error {
	constructor() {
		super("нельзя отправить заявку самому себе");
		this.name = "SelfContactRequestError";
		this.key = "errors.cannotAddSelf";
	}
}

const RUMOR_KIND_TO_EVENT_TYPE = {
	[CONTACT_REQUEST_KIND]: "REMOTE_REQUEST",
	[CONTACT_ACCEPTED_KIND]: "REMOTE_ACCEPT",
	[CONTACT_REJECTED_KIND]: "REMOTE_REJECT",
	[ACQUAINT_CANCELLED_KIND]: "REMOTE_CANCEL",
};

// publish/privKey/ownerPubkey/dbKey — инъецируемые (тот же DI-приём, что
// createCallRuntime, call-runtime.js этап 48): тесты подставляют фейковый publish
// и реальные (тестовые) ключи, без сети/окружения браузера.
export function createContactRuntime(options) {
	const { ownerPubkey, privKey, dbKey, publish, onStateChange = () => {}, onJournal = () => {} } = options;

	let relationships = new Map();

	// Монотонный created_at по kind — тот же приём и то же обоснование, что
	// nextCreatedAt в ui/signals/contacts.js (этап 23-довесок): kind-3/kind-10000
	// в ту же wall-clock секунду иначе тай-брейкаются по id (lww.js), никак не
	// связанному с реальным порядком публикации.
	const lastCreatedAtByKind = new Map();
	function nextCreatedAt(kind) {
		const now = Math.floor(Date.now() / 1000);
		const value = Math.max(now, (lastCreatedAtByKind.get(kind) ?? 0) + 1);
		lastCreatedAtByKind.set(kind, value);
		return value;
	}

	async function load() {
		await migrateLegacyContactTables(ownerPubkey, dbKey);
		const rows = await db.table("contactRelationships").where("owner").equals(ownerPubkey).toArray();
		relationships = new Map(
			rows.map((row) => {
				const state = rowToPeerState(row, dbKey);
				return [state.peerPubkey, state];
			}),
		);
	}

	function getState(peer) {
		return relationships.get(peer) ?? noneState(peer);
	}

	async function persist(peer) {
		const state = relationships.get(peer);
		if (!state) return;
		await db.table("contactRelationships").put(peerStateToRow(ownerPubkey, state, dbKey));
	}

	function peersByState(stateName) {
		const result = [];
		for (const state of relationships.values()) {
			if (state.name === stateName) result.push(state.peerPubkey);
		}
		return result;
	}

	async function executeCommand(cmd) {
		switch (cmd.type) {
			case "PUBLISH_REQUEST":
				await publish(nip59Wrap(buildContactRequestRumor(cmd.greeting), privKey, cmd.peer));
				return;
			case "PUBLISH_ACCEPT":
				await publish(nip59Wrap(buildContactAcceptedRumor(), privKey, cmd.peer));
				return;
			case "PUBLISH_REJECT":
				await publish(nip59Wrap(buildContactRejectedRumor(), privKey, cmd.peer));
				return;
			case "PUBLISH_CANCEL":
				await publish(nip59Wrap(buildAcquaintCancelledRumor(), privKey, cmd.peer));
				return;
			case "UPDATE_CONTACTS_LIST": {
				const event = buildContactListEvent(privKey, peersByState("CONTACT"), nextCreatedAt(3));
				await publish(event);
				return;
			}
			case "UPDATE_MUTE_LIST": {
				const event = buildMuteListEvent(privKey, peersByState("BLOCKED"), nextCreatedAt(10000));
				await publish(event);
				return;
			}
			case "UPSERT":
			case "DELETE":
				// DELETE переводит строку в state:"NONE" (не физическое удаление, см.
				// CONTACTS-FSM.md §2 примечание) — Map уже несёт это состояние к моменту
				// исполнения команды, поэтому обе ветки просто персистят ТЕКУЩИЙ peerState.
				await persist(cmd.peer);
				return;
			case "EMIT":
				onStateChange(cmd.peer, cmd.stateName);
				return;
			case "LOG_JOURNAL":
				onJournal(cmd.entry);
				return;
		}
	}

	async function dispatch(peer, fsmEvent) {
		const current = getState(peer);
		const result = reduce(current, { ...fsmEvent, peer });
		relationships.set(peer, result.state);
		for (const command of result.commands) {
			await executeCommand(command);
		}
	}

	function sendRequest(peer, greeting = "") {
		if (peer === ownerPubkey) throw new SelfContactRequestError();
		return dispatch(peer, { type: "USER_SEND_REQUEST", greeting });
	}
	function accept(peer) {
		return dispatch(peer, { type: "USER_ACCEPT" });
	}
	function reject(peer) {
		return dispatch(peer, { type: "USER_REJECT" });
	}
	function cancel(peer) {
		return dispatch(peer, { type: "USER_CANCEL" });
	}
	function block(peer) {
		return dispatch(peer, { type: "USER_BLOCK" });
	}
	function unblock(peer) {
		return dispatch(peer, { type: "USER_UNBLOCK" });
	}
	function removeContact(peer) {
		return dispatch(peer, { type: "USER_REMOVE_CONTACT" });
	}

	async function handleIncomingRumor(rumor) {
		const type = RUMOR_KIND_TO_EVENT_TYPE[rumor.kind];
		if (!type) return;
		const event = { type, createdAt: rumor.created_at };
		if (type === "REMOTE_REQUEST") event.greeting = rumor.content ?? "";
		await dispatch(rumor.pubkey, event);
	}

	async function reconcileContactList(pubkeySet, createdAt) {
		const result = reconcileList(relationships, "contacts", pubkeySet, createdAt);
		relationships = result.relationships;
		for (const command of result.commands) {
			await executeCommand(command);
		}
	}

	async function reconcileMuteList(pubkeySet, createdAt) {
		const result = reconcileList(relationships, "mute", pubkeySet, createdAt);
		relationships = result.relationships;
		for (const command of result.commands) {
			await executeCommand(command);
		}
	}

	function getPeerState(peer) {
		return relationships.get(peer) ?? null;
	}

	function listPeersByState(stateName) {
		return [...relationships.values()].filter((state) => state.name === stateName);
	}

	return {
		load,
		sendRequest,
		accept,
		reject,
		cancel,
		block,
		unblock,
		removeContact,
		handleIncomingRumor,
		reconcileContactList,
		reconcileMuteList,
		getPeerState,
		listPeersByState,
	};
}
