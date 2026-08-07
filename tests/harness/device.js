import "fake-indexeddb/auto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey } from "../../src/core/crypto/keys.js";
import { deriveMasterSecret, deriveDbKey } from "../../src/core/crypto/derivation.js";
import { db } from "../../src/core/store/database.js";
import { saveUiSettings } from "../../src/domain/settings/ui-settings.js";
import { toEncryptedRow } from "../../src/core/store/encrypted-table.js";
import { CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS } from "../../src/core/store/table-fields.js";
import {
	ensureConnected,
	publishToContact,
	fetchDeviceKeyPackages,
	refreshGroupMessageSubscription,
	nextLamportTick,
} from "../../src/ui/signals/transport.js";
import { sendChatMessageAction } from "../../src/ui/signals/chats.js";
import { getChatHistory } from "../../src/domain/messaging/chat.js";

let privKey = null;
let ownerPubkey = null;
let dbKey = null;

const handlers = {
	async init({ privKeyHex, relayUrl }) {
		privKey = hexToBytes(privKeyHex);
		ownerPubkey = bytesToHex(getPublicKey(privKey));
		dbKey = deriveDbKey(deriveMasterSecret(privKey));
		await db.open();
		// ensureConnected читает relay-список ТОЛЬКО из локального uiSettings —
		// без этой затравки она уйдёт в bootstrap-обнаружение по реальным
		// build-адресам (CONTRACTS.md, "Этап 73.2 — device.js").
		await saveUiSettings(ownerPubkey, privKey, dbKey, { relayUrls: [{ url: relayUrl, read: true, write: true }] }, async () => ({ ok: true }));
		return { ownerPubkey };
	},

	// Обходит реальный протокол заявок (CONTACTS-FSM.md) прямой записью в
	// contactRelationships — тот же уровень допущения, что и в существующих
	// юнит-тестах (chat.test.js и т.п.), которые тоже сеют состояние напрямую,
	// когда протокол заявок не является предметом теста. Без "CONTACT"
	// isKnownContact() отклонит Welcome (DESIGN.md, "Этап 25" §4, AC-IB-01) —
	// он уйдёт в inboxRequests вместо автопринятия, что 73.2's "счастливый
	// путь" не собирается проверять (это отдельный, уже покрытый функционал).
	async becomeContact({ peerPubkey }) {
		const now = Math.floor(Date.now() / 1000);
		await db
			.table("contactRelationships")
			.put(toEncryptedRow({ owner: ownerPubkey, peer: peerPubkey, state: "CONTACT", resolvedAt: now, sentAt: null }, CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS, dbKey));
		return {};
	},

	async connect() {
		await ensureConnected(ownerPubkey, privKey, dbKey);
		return {};
	},

	async send({ contactPubkey, text }) {
		const lamportTs = await nextLamportTick(ownerPubkey);
		await sendChatMessageAction(
			ownerPubkey,
			privKey,
			dbKey,
			contactPubkey,
			text,
			lamportTs,
			(event) => publishToContact(event, contactPubkey),
			fetchDeviceKeyPackages,
			refreshGroupMessageSubscription,
		);
		return { lamportTs };
	},

	async history({ contactPubkey }) {
		return getChatHistory(ownerPubkey, contactPubkey, dbKey);
	},
};

// Команды выполняются строго последовательно, в порядке получения —
// реальная вкладка браузера тоже однопоточна; гонки должны воспроизводиться
// через relay (тайминг доставки), не через порядок обработки IPC.
let queue = Promise.resolve();

process.on("message", ({ id, cmd, args }) => {
	queue = queue.then(async () => {
		const handler = handlers[cmd];
		try {
			if (!handler) throw new Error(`device.js: неизвестная команда "${cmd}"`);
			const result = await handler(args ?? {});
			process.send({ id, ok: true, result });
		} catch (e) {
			process.send({ id, ok: false, error: String(e && e.stack ? e.stack : e) });
		}
	});
});
