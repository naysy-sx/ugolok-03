// Rooms, этап 4 — оркестрация n(n-1)/2 звонковых runtime'ов под голосовую сетку
// комнаты. Контракт и design-записка: PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 4"
// (mesh-supervisor.js). ROOMS-SPEC.md §4.3.
//
// Существующий звонковый слой (call-fsm.js/media-controller.js/call-runtime.js)
// НЕ переписывается — супервизор создаёt n-1 независимых createCallRuntime,
// по одному на ребро, ориентированных турниром mesh.js (edges/diffEdges, Этап 1).
import { createCallRuntime as defaultCreateCallRuntime } from "../../calls/call-runtime.js";
import { edges, diffEdges } from "../mesh.js";

export function createMeshSupervisor({
	selfPubkey,
	selfPrivKey,
	hTopic,
	publish,
	maxVoice,
	getUserMedia,
	iceServers = [],
	createCallRuntime = defaultCreateCallRuntime,
}) {
	let sharedStream = null;
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
		});
		edgesByPeer.set(peer, { runtime, role });
		if (role === "initiator") runtime.placeCall(peer);
	}

	function closeEdge(peer) {
		const edge = edgesByPeer.get(peer);
		if (!edge) return;
		edge.runtime.hangup();
		edgesByPeer.delete(peer);
	}

	async function joinVoice() {
		sharedStream = await getUserMedia({ audio: true });
	}

	function leaveVoice() {
		for (const peer of [...edgesByPeer.keys()]) closeEdge(peer);
		currentMyEdges = [];
		if (sharedStream) {
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

	function onSignal(event) {
		const edge = edgesByPeer.get(event.pubkey);
		if (!edge) return; // несуществующее/уже закрытое ребро — рутинный случай при гонке закрытия
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
