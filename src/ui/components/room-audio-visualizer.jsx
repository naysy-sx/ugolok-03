import { useEffect, useRef, useState } from "preact/hooks";
import { createAudioGraph } from "../../domain/rooms/adapters/audio-graph.js";
import { t } from "../signals/i18n.js";
import { record as defaultTraceRecord, isTraceEnabled } from "../../core/diag/call-trace.js";

// Rooms, этап 5 — визуализатор комнаты (волна + "кто говорит" + регулятор
// громкости). Контракт: PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 5".
//
// Один requestAnimationFrame на всю комнату (ROOMS-ALGO §7.4) — этот компонент
// существует РОВНО в одном экземпляре на сессию. Владеет audio-graph.js
// (создаёт при появлении localStream). Рендерится ВСЕГДА, пока voiceActive —
// воспроизведение не зависит от того, свёрнут ли канвас.
const CANVAS_WIDTH = 300;
const CANVAS_HEIGHT = 80;
const LEVELS_EVERY_N_FRAMES = 4;
const BAR_CSS_PX = 2;
const GAP_CSS_PX = 1;
// Кислотная тройка: бас / середина / верх.
const COLOR_LOW = [255, 16, 240];
const COLOR_MID = [57, 255, 20];
const COLOR_HIGH = [0, 255, 255];

function lerpChannel(a, b, t) {
	return a + (b - a) * t;
}

function colorForBand(t) {
	if (t < 0.5) {
		const u = t / 0.5;
		return [
			lerpChannel(COLOR_LOW[0], COLOR_MID[0], u),
			lerpChannel(COLOR_LOW[1], COLOR_MID[1], u),
			lerpChannel(COLOR_LOW[2], COLOR_MID[2], u),
		];
	}
	const u = (t - 0.5) / 0.5;
	return [
		lerpChannel(COLOR_MID[0], COLOR_HIGH[0], u),
		lerpChannel(COLOR_MID[1], COLOR_HIGH[1], u),
		lerpChannel(COLOR_MID[2], COLOR_HIGH[2], u),
	];
}

export default function RoomAudioVisualizer({ localStream, remoteStreams, selfPubkey, participantNicks, audioPoolRef, audioContext }) {
	const canvasRef = useRef(null);
	const audioGraphRef = useRef(null);
	const [levels, setLevels] = useState(new Map());
	const [gain, setGain] = useState(1);
	const [audioBlocked, setAudioBlocked] = useState(false);
	const slotByPeerRef = useRef(new Map());
	const prevRemotePeersRef = useRef(new Set());
	const prevRemoteStreamsRef = useRef(new Map());
	const trace = isTraceEnabled() ? defaultTraceRecord : null;

	// Граф создаётся, когда появляется localStream (voiceActive стал true), и
	// закрывается, когда он пропадает (voiceActive стал false / leaveVoice()).
	useEffect(() => {
		if (!localStream) return;
		const graph = createAudioGraph(audioContext ? { context: audioContext } : {});
		graph.setMasterGain(0);
		void graph.resume();
		graph.addStream(selfPubkey, localStream, { isSelf: true });
		audioGraphRef.current = graph;
		return () => {
			graph.close();
			audioGraphRef.current = null;
		};
		// selfPubkey стабилен на сессию (эфемерная identity, ROOMS-SPEC §0) —
		// намеренно не пересоздавать граф из-за него.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [localStream]);

	useEffect(() => {
		const graph = audioGraphRef.current;
		if (!graph) return;
		const currentPeers = new Set(remoteStreams.keys());
		const prev = prevRemotePeersRef.current;
		for (const peer of currentPeers) {
			const stream = remoteStreams.get(peer);
			if (!prev.has(peer) || prevRemoteStreamsRef.current.get(peer) !== stream) {
				graph.addStream(peer, stream, { isSelf: false });
			}
		}
		for (const peer of prev) {
			if (!currentPeers.has(peer)) graph.removeStream(peer);
		}
		prevRemotePeersRef.current = currentPeers;
		prevRemoteStreamsRef.current = new Map(remoteStreams);
	}, [remoteStreams, localStream]);

	useEffect(() => {
		const audioPool = audioPoolRef?.current;
		if (!audioPool || audioPool.length === 0) return;
		const slotByPeer = slotByPeerRef.current;
		const occupied = new Set(slotByPeer.values());
		for (const [peer, stream] of remoteStreams.entries()) {
			let idx = slotByPeer.get(peer);
			if (idx === undefined || idx >= audioPool.length) {
				idx = -1;
				for (let i = 0; i < audioPool.length; i++) {
					if (!occupied.has(i)) {
						idx = i;
						break;
					}
				}
				if (idx < 0) continue;
				slotByPeer.set(peer, idx);
				occupied.add(idx);
			}
			const el = audioPool[idx];
			if (!el) continue;
			if (el.srcObject !== stream) {
				el.removeAttribute("src");
				el.srcObject = stream;
				el.play().then(
					() => trace?.("play-attempt", { peer, ok: true }),
					(err) => {
						trace?.("play-rejected", { peer, name: err?.name ?? "Error" });
						setAudioBlocked(true);
					},
				);
			}
		}
		for (const [peer, idx] of [...slotByPeer.entries()]) {
			if (remoteStreams.has(peer)) continue;
			const el = audioPool[idx];
			if (el) {
				el.srcObject = null;
				el.removeAttribute("src");
			}
			slotByPeer.delete(peer);
		}
	}, [remoteStreams, audioPoolRef, trace]);

	useEffect(() => {
		const audioPool = audioPoolRef?.current;
		if (!audioPool) return;
		for (const el of audioPool) el.volume = gain;
	}, [gain, audioPoolRef]);

	useEffect(() => {
		audioGraphRef.current?.setMasterGain(0);
	}, [gain]);

	useEffect(() => {
		if (!localStream || !canvasRef.current) return;
		const canvas = canvasRef.current;
		const ctx = canvas.getContext("2d");
		let raf;
		let frame = 0;

		function syncSize() {
			const dpr = window.devicePixelRatio || 1;
			const cssW = canvas.clientWidth || CANVAS_WIDTH;
			const cssH = canvas.clientHeight || CANVAS_HEIGHT;
			const w = Math.max(1, Math.floor(cssW * dpr));
			const h = Math.max(1, Math.floor(cssH * dpr));
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w;
				canvas.height = h;
			}
			return { w, h, dpr };
		}

		function drawWave(spectrum, w, h, dpr) {
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, w, h);
			const barW = Math.max(1, Math.round(BAR_CSS_PX * dpr));
			const gap = Math.max(0, Math.round(GAP_CSS_PX * dpr));
			const stride = barW + gap;
			const n = Math.floor(w / stride);
			if (n <= 0 || !spectrum || spectrum.length === 0) return;
			const midY = h / 2;
			ctx.shadowBlur = 8 * dpr;
			for (let i = 0; i < n; i++) {
				const specIndex = Math.min(spectrum.length - 1, Math.floor((i / n) * spectrum.length));
				const v = spectrum[specIndex] / 255;
				const amp = Math.max(dpr, v * h * 0.48);
				const t = n === 1 ? 0 : i / (n - 1);
				const [r, g, b] = colorForBand(t);
				const x = i * stride;
				ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${0.4 + v * 0.6})`;
				ctx.shadowColor = `rgba(${r | 0}, ${g | 0}, ${b | 0}, 0.85)`;
				ctx.fillRect(x, midY - amp, barW, amp * 2);
			}
			ctx.shadowBlur = 0;
		}

		function tick() {
			const graph = audioGraphRef.current;
			const { w, h, dpr } = syncSize();
			if (graph) {
				drawWave(graph.getSpectrum(), w, h, dpr);
				if (frame % LEVELS_EVERY_N_FRAMES === 0) setLevels(graph.getLevels());
			} else {
				ctx.fillStyle = "#fff";
				ctx.fillRect(0, 0, w, h);
			}
			frame++;
			raf = requestAnimationFrame(tick);
		}
		raf = requestAnimationFrame(tick);

		return () => cancelAnimationFrame(raf);
	}, [localStream]);

	if (!localStream) return null;

	function handleEnableSound() {
		const audioPool = audioPoolRef?.current;
		if (!audioPool) return;
		Promise.all(audioPool.map((el) => el.play().catch((err) => err))).then((results) => {
			const blocked = results.some((r) => r instanceof Error);
			setAudioBlocked(blocked);
			for (const [peer] of remoteStreams.entries()) {
				if (blocked) trace?.("play-rejected", { peer, name: "NotAllowedError" });
				else trace?.("play-attempt", { peer, ok: true });
			}
		});
	}

	return (
		<div class="room-audio-visualizer stack box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}>
			<canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} class="room-spectrogram" aria-hidden="true" />
			{audioBlocked && (
				<button type="button" class="btn self-start" onClick={handleEnableSound}>
					{t("quick.room.enableSoundButton")}
				</button>
			)}
			<label class="row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
				{t("quick.room.volumeLabel")}
				<input type="range" min="0" max="1" step="0.05" value={gain} onInput={(e) => setGain(Number(e.currentTarget.value))} />
			</label>
			<ul class="room-speaking-indicators row" style={{ "--gap": "var(--space-xs)" }} role="list">
				{[...levels.entries()].map(([peer, { speaking }]) => (
					<li key={peer} class={speaking ? "room-speaking-active" : ""}>
						{participantNicks?.get(peer) ?? peer.slice(0, 8)}
					</li>
				))}
			</ul>
		</div>
	);
}
