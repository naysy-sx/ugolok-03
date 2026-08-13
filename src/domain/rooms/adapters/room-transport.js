// Rooms, этап 2 — собственный транспортный клиент комнаты. Контракт:
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 2" (room-transport.js); ROOMS-SPEC.md §4.2.
//
// Второй, независимый транспортный клиент (ROOMS-SPEC §0) — собственное
// соединение, НЕ трогает module-level connection из ui/signals/transport.js.
import { createRelayConnection } from "../../../core/transport/relay-pool.js";
import { createPublisher } from "../../../core/transport/publisher.js";
import { createSubscriber } from "../../../core/transport/subscriber.js";
import { verify } from "../../../core/crypto/sign.js";
import { ROOM_ANNOUNCE_KIND, ROOM_PROBE_KIND, ROOM_PRESENCE_KIND, ROOM_CHAT_KIND, ROOM_POINTER_KIND } from "../../events/kind-registry.js";
import { CALL_SIGNAL_KIND } from "../../calls/signaling-adapter.js";

const ROOM_KINDS = [ROOM_ANNOUNCE_KIND, ROOM_PROBE_KIND, ROOM_PRESENCE_KIND, ROOM_CHAT_KIND, CALL_SIGNAL_KIND];
const SUB_ID = "room";

function waitForConnState(conn, predicate, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (predicate(conn.getState())) return resolve();
		const t0 = Date.now();
		const iv = setInterval(() => {
			if (predicate(conn.getState())) {
				clearInterval(iv);
				resolve();
			} else if (Date.now() - t0 > timeoutMs) {
				clearInterval(iv);
				reject(new Error(`room-transport: таймаут ожидания состояния соединения (сейчас: "${conn.getState()}")`));
			}
		}, 50);
	});
}

function hasTag(event, name, value) {
	return event.tags.some((tag) => tag[0] === name && tag[1] === value);
}

// hTopic/hDisc — как минимум один обязателен (Этап 3, открытый режим): joiner
// по паролю на фазе обнаружения знает только hDisc (suffix, а с ним hTopic, ещё
// не найден); обычная закрытая/уже-найденная сессия знает hTopic (и опционально
// ТАКЖЕ hDisc — открытый режим создателя слушает указатели-конкуренты, И9).
export async function openRoomTransport({ relayUrl, hTopic = null, hDisc = null, selfPubkey, onEvent }) {
	if (!hTopic && !hDisc) throw new Error("room-transport: нужен хотя бы один из hTopic/hDisc");
	const conn = createRelayConnection(relayUrl, {});
	conn.connect();
	await waitForConnState(conn, (s) => s === "connected", 8000);

	const publisher = createPublisher(conn);

	function verifyBatch(events) {
		return events.map(verify);
	}

	function onBatch(events) {
		for (const event of events) {
			if (event.kind === ROOM_POINTER_KIND) {
				if (!hDisc || !hasTag(event, "h", hDisc)) continue;
				onEvent(event);
				continue;
			}
			if (!hTopic || !hasTag(event, "h", hTopic)) continue;
			if (event.kind === CALL_SIGNAL_KIND && !hasTag(event, "p", selfPubkey)) continue;
			onEvent(event);
		}
	}

	const subscriber = createSubscriber(conn, { verifyBatch, onBatch, onEose: () => {} });

	conn.addMessageHandler(publisher.handleMessage);
	conn.addMessageHandler(subscriber.handleMessage);
	const filters = [];
	if (hTopic) filters.push({ kinds: ROOM_KINDS, "#h": [hTopic] });
	if (hDisc) filters.push({ kinds: [ROOM_POINTER_KIND], "#h": [hDisc] });
	subscriber.subscribe(SUB_ID, filters);

	function publish(event) {
		return publisher.publish(event);
	}

	function close() {
		conn.close();
	}

	return { publish, close };
}
