// Rooms, этап 4 — оркестрация n(n-1)/2 звонковых runtime'ов под голосовую сетку
// комнаты. Контракт и design-записка: PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 4"
// (mesh-supervisor.js). ROOMS-SPEC.md §4.3.
//
// Существующий звонковый слой (call-fsm.js/media-controller.js/call-runtime.js)
// НЕ переписывается — супервизор создаёt n-1 независимых createCallRuntime,
// по одному на ребро, ориентированных турниром mesh.js (edges/diffEdges, Этап 1).
import { createCallRuntime as defaultCreateCallRuntime } from "../../calls/call-runtime.js";
import { edges, diffEdges } from "../mesh.js";

// НАЙДЕНО ЖИВОЙ ПРОВЕРКОЙ (три реальных браузера, тишина СОХРАНИЛАСЬ и после
// фикса onSignal выше): тот же класс пробела, что уже находился и чинился в
// 1:1-звонках (call-overlay.jsx's RemoteAudio, комментарий там же) — трек
// собеседника доходит до RTCPeerConnection (media-controller.js's pc.ontrack),
// но НИКУДА не воспроизводится без явного <audio> с srcObject. mesh-
// supervisor.js своих <audio> не создаёт (это UI-забота) — вместо этого
// ребро получает onRemoteStream, супервизор форвардит (peer, stream) наверх
// через ТОТ ЖЕ инъецируемый колбэк вызывающему коду (room-session.js -> UI),
// который и рисует по одному скрытому <audio> на пира.
export function createMeshSupervisor({
	selfPubkey,
	selfPrivKey,
	hTopic,
	publish,
	maxVoice,
	getUserMedia,
	iceServers = [],
	createCallRuntime = defaultCreateCallRuntime,
	onRemoteStream = () => {},
	onLocalStream = () => {},
}) {
	let sharedStream = null;
	let joinGeneration = 0; // Этап 6 — отмена гонки joinVoice()/leaveVoice(), см. joinVoice ниже
	const edgesByPeer = new Map(); // peerPubkey -> {runtime, role}
	let currentMyEdges = [];

	function openEdge(peer, role) {
		const runtime = createCallRuntime({
			myPubkey: selfPubkey,
			privKey: selfPrivKey,
			publish,
			hTopic,
			iceServers,
			getUserMediaImpl: () => Promise.resolve(sharedStream.clone()),
			onStateChange: (stateName) => {
				if (stateName === "INCOMING_RINGING") runtime.accept();
			},
			onRemoteStream: (stream) => onRemoteStream(peer, stream),
		});
		edgesByPeer.set(peer, { runtime, role });
		if (role === "initiator") runtime.placeCall(peer);
	}

	function closeEdge(peer) {
		const edge = edgesByPeer.get(peer);
		if (!edge) return;
		edge.runtime.hangup();
		edgesByPeer.delete(peer);
		onRemoteStream(peer, null); // UI обязана убрать/остановить <audio> этого пира
	}

	// Этап 6, найдено адверсарной фазой (CONTRACTS.md "Rooms — Этап 6"): getUserMedia
	// асинхронен — если leaveVoice() (например, закрытие всей комнаты, пока висит
	// нативный запрос разрешения микрофона) срабатывает ДО того, как этот await
	// резолвится, joinGeneration не совпадёт на выходе — только что полученный
	// поток немедленно останавливается и НЕ становится sharedStream, вместо того
	// чтобы молча "воскресить" голос, который пользователь уже явно покинул.
	async function joinVoice() {
		const myGeneration = ++joinGeneration;
		const stream = await getUserMedia({ audio: true });
		if (myGeneration !== joinGeneration) {
			for (const track of stream.getTracks()) track.stop();
			return false;
		}
		sharedStream = stream;
		// Этап 5 — audio-graph.js's addStream(selfPubkey, ..., {isSelf:true}) нужен
		// именно ЭТОТ, сырой (не клонированный) поток для собственного уровня/
		// спектрограммы; клоны на рёбра — отдельно, ниже.
		onLocalStream(sharedStream);
		return true;
	}

	function leaveVoice() {
		joinGeneration++; // отменяет любой ещё не завершённый joinVoice()
		for (const peer of [...edgesByPeer.keys()]) closeEdge(peer);
		currentMyEdges = [];
		if (sharedStream) {
			onLocalStream(null);
			for (const track of sharedStream.getTracks()) track.stop();
			sharedStream = null;
		}
	}

	function updateRoster(pubkeys) {
		if (!sharedStream) return; // нечем открывать рёбра — joinVoice() ещё не вызван / уже leaveVoice()
		const capped = pubkeys.slice(0, maxVoice); // защитное усечение — см. CONTRACTS.md "Rooms — Этап 4"
		const allEdges = edges(capped);
		const myNewEdges = allEdges.filter(([a, b]) => a === selfPubkey || b === selfPubkey);
		const { toOpen, toClose } = diffEdges(currentMyEdges, myNewEdges);
		currentMyEdges = myNewEdges;

		for (const edge of toClose) {
			const peer = edge[0] === selfPubkey ? edge[1] : edge[0];
			closeEdge(peer);
		}
		for (const edge of toOpen) {
			const peer = edge[0] === selfPubkey ? edge[1] : edge[0];
			const role = edge[0] === selfPubkey ? "initiator" : "responder";
			openEdge(peer, role);
		}
	}

	// НАЙДЕНО ЖИВОЙ ПРОВЕРКОЙ (три реальных браузера, полная тишина): heartbeat
	// (roster, объявляет "я в голосе") и offer (сигнал ребра) — ДВЕ независимые
	// публикации без гарантии порядка доставки. Если оффер от инициатора приходит
	// РАНЬШЕ, чем наш собственный updateRoster узнал о нём через heartbeat,
	// edgesByPeer ещё пуст для этого пира — старая версия молча роняла offer
	// НАВСЕГДА (retry нет), ребро не формировалось никогда. Событие уже прошло
	// предфильтр room-transport.js (тег p=self, h=hTopic, валидная NIP-44-
	// расшифровка внутри handleIncomingSignal) — отправитель легитимен для
	// комнаты, поэтому реактивно открываем ребро как responder (мы явно не
	// инициатор — инициатор сам посылает offer, не ждёт его).
	function onSignal(event) {
		const peer = event.pubkey;
		let edge = edgesByPeer.get(peer);
		if (!edge) {
			if (!sharedStream) return; // не в голосе вовсе — некуда открывать
			openEdge(peer, "responder");
			edge = edgesByPeer.get(peer);
			// currentMyEdges — синхронизировать, иначе следующий updateRoster()
			// решит, что это ребро "новое", и продублирует открытие через diffEdges.
			const pairKey = [selfPubkey, peer].sort();
			const alreadyTracked = currentMyEdges.some(([a, b]) => a === pairKey[0] && b === pairKey[1]);
			if (!alreadyTracked) currentMyEdges = [...currentMyEdges, pairKey];
		}
		edge.runtime.handleIncomingSignal(event);
	}

	function getEdgeStates() {
		return [...edgesByPeer.entries()].map(([peer, { runtime, role }]) => ({
			peer,
			role,
			state: runtime.getState().name,
		}));
	}

	return { joinVoice, leaveVoice, updateRoster, onSignal, getEdgeStates };
}
