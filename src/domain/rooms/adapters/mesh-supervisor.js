// Rooms — оркестрация n(n-1)/2 звонковых runtime'ов под голосовую сетку
// комнаты. Политика жизненного цикла ребра живёт ЗДЕСЬ, не в call-fsm.js
// (FSM общая с 1:1-звонком, где «не дозвонился» терминально).
//
// Желаемое множество пар считается каждый тик; мёртвое ребро пересоздаётся.
// Роль — только турнир по pubkey, никогда порядок сигналов.
import { createCallRuntime as defaultCreateCallRuntime } from "../../calls/call-runtime.js";

export const DEFAULT_OPEN_BUDGET_MS = 25000;
export const DEFAULT_HEALTH_STALE_MS = 6000;
export const DEFAULT_HEALTH_POLL_MS = 2000;
export const BROKEN_BANNER_AFTER_ATTEMPTS = 4;
// Два-три периода heartbeat (δ=15с). Держит реактивно открытое ребро, пока
// presence не догонит offer. Срез maxVoice применяется после объединения.
export const SIGNAL_GRACE_MS = 25000;

const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 15000];

export function roleFor(selfPubkey, peer) {
	return selfPubkey < peer ? "initiator" : "responder";
}

export function backoffMs(attempts) {
	const i = Math.max(0, attempts - 1);
	return BACKOFF_STEPS_MS[Math.min(i, BACKOFF_STEPS_MS.length - 1)];
}
// Страховка только быстрых отказов (ENDED сразу). Обычный путь broken
// наступает не раньше CONNECT_TIMEOUT 15с / openBudgetMs 25с — к тому
// моменту nextAttemptAt уже в прошлом, каденцией правят те константы.

// phase: "live" | "opening" | "recovering" | "broken"
// CONNECTED без пакетов — не live: ICE сошёлся, слышно ещё нет.
export function edgePhase(edge, now, { openBudgetMs = DEFAULT_OPEN_BUDGET_MS, healthStaleMs = DEFAULT_HEALTH_STALE_MS } = {}) {
	const s = edge.runtime.getState().name;
	if (s === "CONNECTED") {
		if (edge.lastHealthyAt === null) {
			const since = edge.connectedAt ?? edge.openedAt;
			return now - since > healthStaleMs ? "broken" : "opening";
		}
		return now - edge.lastHealthyAt > healthStaleMs ? "broken" : "live";
	}
	if (s === "RECONNECTING") return "recovering";
	if (s === "ENDED") return "broken";
	if (s === "IDLE") {
		if (!edge.everLeftIdle && now - edge.openedAt <= openBudgetMs) return "opening";
		return "broken";
	}
	return now - edge.openedAt > openBudgetMs ? "broken" : "opening";
}

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
	onEdgeClosed = null,
	onLocalStream = () => {},
	onTrace,
	getRelayState,
	getIceCredsExpiryMs,
	openBudgetMs = DEFAULT_OPEN_BUDGET_MS,
	healthStaleMs = DEFAULT_HEALTH_STALE_MS,
	healthPollMs = DEFAULT_HEALTH_POLL_MS,
}) {
	const budgets = { openBudgetMs, healthStaleMs };
	const notifyEdgeClosed = onEdgeClosed ?? ((peer) => onRemoteStream(peer, null));

	function trace(ev, payload) {
		if (!onTrace) return;
		try {
			onTrace(ev, payload);
		} catch {
			// TZ §0.5
		}
	}

	let sharedStream = null;
	let joinGeneration = 0;
	const edgesByPeer = new Map();
	let desiredPeers = [];
	const signalSeenAt = new Map();
	let lastReconcileNow = 0;
	let lastHealthPollAt = -Infinity;
	let healthPolling = false;

	function stopClone(edge) {
		const clone = edge?.localClone;
		if (!clone || typeof clone.getTracks !== "function") {
			if (edge) edge.localClone = null;
			return;
		}
		for (const track of clone.getTracks()) {
			try {
				track.stop();
			} catch {
				// клон мог уже быть остановлен
			}
		}
		edge.localClone = null;
	}

	function attachRuntime(peer, edge) {
		const gen = edge.generation;
		const runtime = createCallRuntime({
			myPubkey: selfPubkey,
			privKey: selfPrivKey,
			publish,
			hTopic,
			iceServers,
			ownsLocalStream: false,
			getUserMediaImpl: () => {
				const clone = sharedStream.clone();
				edge.localClone = clone;
				return Promise.resolve(clone);
			},
			onTrace,
			getRelayState,
			getIceCredsExpiryMs,
			onStateChange: (stateName) => {
				const current = edgesByPeer.get(peer);
				if (!current || current.generation !== gen) return;
				if (stateName !== "IDLE") current.everLeftIdle = true;
				trace("edge-state", { peer, role: current.role, state: stateName, generation: gen });
				if (stateName === "INCOMING_RINGING") {
					queueMicrotask(() => {
						const still = edgesByPeer.get(peer);
						if (!still || still.generation !== gen) return;
						runtime.accept();
					});
				}
			},
			onRemoteStream: (stream) => {
				const current = edgesByPeer.get(peer);
				if (!current || current.generation !== gen) return;
				if (stream) onRemoteStream(peer, stream);
			},
		});
		edge.runtime = runtime;
		if (edge.role === "initiator") runtime.placeCall(peer);
	}

	function openEdge(peer, role, now) {
		const edge = {
			runtime: null,
			role,
			generation: 0,
			attempts: 0,
			nextAttemptAt: now,
			openedAt: now,
			connectedAt: null,
			lastHealthyAt: null,
			lastPackets: 0,
			localClone: null,
			everLeftIdle: false,
		};
		edgesByPeer.set(peer, edge);
		attachRuntime(peer, edge);
	}

	function reopenEdge(peer, now) {
		const edge = edgesByPeer.get(peer);
		if (!edge) return;
		const oldRuntime = edge.runtime;
		edge.generation += 1;
		edge.attempts += 1;
		edge.nextAttemptAt = now + backoffMs(edge.attempts);
		edge.openedAt = now;
		edge.connectedAt = null;
		edge.lastHealthyAt = null;
		edge.lastPackets = 0;
		edge.everLeftIdle = false;
		if (oldRuntime) {
			oldRuntime.hangup();
			oldRuntime.closeNow?.();
		}
		stopClone(edge);
		attachRuntime(peer, edge);
	}

	function closeEdge(peer) {
		const edge = edgesByPeer.get(peer);
		if (!edge) return;
		edge.generation += 1;
		edge.runtime.hangup();
		edge.runtime.closeNow?.();
		stopClone(edge);
		edgesByPeer.delete(peer);
		notifyEdgeClosed(peer);
	}

	async function joinVoice() {
		const myGeneration = ++joinGeneration;
		const stream = await getUserMedia({ audio: true });
		if (myGeneration !== joinGeneration) {
			for (const track of stream.getTracks()) track.stop();
			return false;
		}
		sharedStream = stream;
		onLocalStream(sharedStream);
		return true;
	}

	function leaveVoice() {
		joinGeneration++;
		for (const peer of [...edgesByPeer.keys()]) closeEdge(peer);
		desiredPeers = [];
		signalSeenAt.clear();
		lastHealthPollAt = -Infinity;
		healthPolling = false;
		if (sharedStream) {
			onLocalStream(null);
			for (const track of sharedStream.getTracks()) track.stop();
			sharedStream = null;
		}
	}

	function setDesiredPeers(pubkeys) {
		desiredPeers = Array.isArray(pubkeys) ? [...pubkeys] : [];
	}

	function desiredNow(now) {
		const others = [];
		const seen = new Set();
		for (const p of desiredPeers) {
			if (p === selfPubkey || seen.has(p)) continue;
			others.push(p);
			seen.add(p);
		}
		for (const [peer, at] of signalSeenAt) {
			if (now - at > SIGNAL_GRACE_MS) {
				signalSeenAt.delete(peer);
				continue;
			}
			if (peer === selfPubkey || seen.has(peer)) continue;
			others.push(peer);
			seen.add(peer);
		}
		return new Set(others.slice(0, Math.max(0, maxVoice - 1)));
	}

	function reconcile(now) {
		lastReconcileNow = now;
		if (!sharedStream) return;
		// Префикс обязан быть детерминированным у всех наблюдателей
		// (present() сортирует по (joinedAt, pubkey)), иначе сетка разъедется.
		// Срез maxVoice — после объединения ростера с grace сигнальных пиров.
		const desiredSet = desiredNow(now);
		const actual = [...edgesByPeer.keys()];
		const toClose = actual.filter((p) => !desiredSet.has(p));
		const toOpen = [...desiredSet].filter((p) => !edgesByPeer.has(p));
		const toReopen = [];

		for (const peer of toClose) closeEdge(peer);

		for (const peer of desiredSet) {
			let edge = edgesByPeer.get(peer);
			if (!edge) {
				openEdge(peer, roleFor(selfPubkey, peer), now);
				continue;
			}
			const stateName = edge.runtime.getState().name;
			if (stateName !== "IDLE") edge.everLeftIdle = true;
			if (stateName === "CONNECTED" && edge.connectedAt === null) {
				edge.connectedAt = now;
			}
			const phase = edgePhase(edge, now, budgets);
			if (phase === "live") {
				edge.attempts = 0;
				continue;
			}
			if (phase === "opening" || phase === "recovering") continue;
			if (phase === "broken" && now >= edge.nextAttemptAt) {
				toReopen.push(peer);
				reopenEdge(peer, now);
			}
		}

		if (toOpen.length > 0 || toClose.length > 0 || toReopen.length > 0) {
			trace("roster-diff", {
				toOpen,
				toClose,
				reopened: toReopen,
				desired: [...desiredSet],
				actual,
			});
		}
	}

	function onSignal(event, now = lastReconcileNow) {
		const peer = event.pubkey;
		if (!sharedStream) return;
		signalSeenAt.set(peer, now);
		let edge = edgesByPeer.get(peer);
		if (!edge) {
			openEdge(peer, roleFor(selfPubkey, peer), now);
			edge = edgesByPeer.get(peer);
		}
		edge.runtime.handleIncomingSignal(event);
	}

	async function pollHealth(now) {
		if (healthPolling) return;
		if (now - lastHealthPollAt < healthPollMs) return;
		lastHealthPollAt = now;
		healthPolling = true;
		try {
			for (const [peer, edge] of [...edgesByPeer]) {
				const gen = edge.generation;
				const runtime = edge.runtime;
				let st = null;
				try {
					st = (await runtime.getInboundAudioStats?.()) ?? null;
				} catch {
					st = null;
				}
				const current = edgesByPeer.get(peer);
				if (!current || current.generation !== gen) continue;
				const stateName = current.runtime.getState().name;
				if (st && st.packetsReceived > current.lastPackets) {
					current.lastPackets = st.packetsReceived;
					current.lastHealthyAt = now;
				}
				trace("edge-health", {
					peer,
					state: stateName,
					packetsReceived: st?.packetsReceived ?? current.lastPackets,
					bytesReceived: st?.bytesReceived ?? 0,
					jitter: st?.jitter ?? null,
					localType: st?.localType ?? null,
					remoteType: st?.remoteType ?? null,
				});
			}
		} finally {
			healthPolling = false;
		}
	}

	function retryEdge(peer, now) {
		const edge = edgesByPeer.get(peer);
		if (!edge) return;
		edge.attempts = 0;
		edge.nextAttemptAt = now;
		reopenEdge(peer, now);
	}

	function getEdgeStates() {
		return [...edgesByPeer.entries()].map(([peer, edge]) => ({
			peer,
			role: edge.role,
			state: edge.runtime.getState().name,
			phase: edgePhase(edge, lastReconcileNow, budgets),
			attempts: edge.attempts,
			generation: edge.generation,
		}));
	}

	return {
		joinVoice,
		leaveVoice,
		setDesiredPeers,
		reconcile,
		onSignal,
		pollHealth,
		retryEdge,
		getEdgeStates,
	};
}
