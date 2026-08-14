import { useEffect, useRef, useState } from "preact/hooks";
import { createAudioGraph } from "../../domain/rooms/adapters/audio-graph.js";
import { computeBlitRegions, nextWriteIndex } from "../../domain/rooms/ring-column-blit.js";
import { t } from "../signals/i18n.js";

// Rooms, этап 5 — визуализатор комнаты (спектрограмма + "кто говорит" + регулятор
// громкости). Контракт и design-записка: PROCESS-DOCS/CONTRACTS.md/DESIGN.md
// "Rooms — Этап 5". ROOMS-SPEC §4.4, ROOMS-ALGO §7.
//
// Один requestAnimationFrame на всю комнату (ROOMS-ALGO §7.4) — этот компонент
// существует РОВНО в одном экземпляре на сессию (не на участника). Владеет
// собственным audio-graph.js (создаёт при появлении localStream, закрывает при
// его исчезновении) — ЕДИНСТВЕННЫЙ путь воспроизведения удалённых участников
// (замена <audio>-элементов Этапа 4-довеска №2, design-записка "Rooms — Этап 5":
// два параллельных пути одного MediaStream дали бы удвоенный звук).
//
// Рендерится ВСЕГДА, пока voiceActive (quick.jsx) — воспроизведение не должно
// зависеть от того, свёрнут ли визуально канвас.
const CANVAS_WIDTH = 300;
const CANVAS_HEIGHT = 80;
const LEVELS_EVERY_N_FRAMES = 4; // ROOMS-ALGO §7.4 — "каждый третий-четвёртый"

export default function RoomAudioVisualizer({ localStream, remoteStreams, selfPubkey, participantNicks }) {
	const canvasRef = useRef(null);
	const bufferCanvasRef = useRef(null);
	const writeIndexRef = useRef(0);
	const audioGraphRef = useRef(null);
	const [levels, setLevels] = useState(new Map());
	const [gain, setGain] = useState(1);

	// Граф создаётся, когда появляется localStream (voiceActive стал true), и
	// закрывается, когда он пропадает (voiceActive стал false / leaveVoice()).
	useEffect(() => {
		if (!localStream) return;
		const graph = createAudioGraph();
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

	// Диффинг remoteStreams (Map<peer, MediaStream>) -> addStream/removeStream.
	// Тот же принцип diff, что mesh-supervisor.js's updateRoster/diffEdges, но
	// без турнира (просто добавить недостающее, убрать пропавшее).
	useEffect(() => {
		const graph = audioGraphRef.current;
		if (!graph) return;
		const currentPeers = new Set(remoteStreams.keys());
		for (const peer of currentPeers) graph.addStream(peer, remoteStreams.get(peer), { isSelf: false });
		return () => {
			for (const peer of currentPeers) graph.removeStream(peer);
		};
	}, [remoteStreams, localStream]);

	useEffect(() => {
		audioGraphRef.current?.setMasterGain(gain);
	}, [gain]);

	useEffect(() => {
		if (!localStream || !canvasRef.current) return;
		const visibleCanvas = canvasRef.current;
		const bufferCanvas = document.createElement("canvas");
		bufferCanvas.width = CANVAS_WIDTH;
		bufferCanvas.height = CANVAS_HEIGHT;
		bufferCanvasRef.current = bufferCanvas;
		const bufferCtx = bufferCanvas.getContext("2d");
		const visibleCtx = visibleCanvas.getContext("2d");
		const accentColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4a90d9";
		writeIndexRef.current = 0;
		let raf;
		let frame = 0;

		function drawColumn(spectrum) {
			const x = writeIndexRef.current;
			bufferCtx.clearRect(x, 0, 1, CANVAS_HEIGHT);
			bufferCtx.fillStyle = accentColor;
			// Каждая строка канваса — один сэмпл спектра (ближайший сосед), O(H) на столбец.
			for (let row = 0; row < CANVAS_HEIGHT; row++) {
				const binIndex = Math.floor(((CANVAS_HEIGHT - 1 - row) / CANVAS_HEIGHT) * spectrum.length);
				const value = spectrum[binIndex] / 255;
				if (value <= 0.02) continue; // тишина — не рисовать (быстрее, чем rgba с alpha=0)
				bufferCtx.globalAlpha = value;
				bufferCtx.fillRect(x, row, 1, 1);
			}
			bufferCtx.globalAlpha = 1;
			writeIndexRef.current = nextWriteIndex(writeIndexRef.current, CANVAS_WIDTH);
		}

		function render() {
			visibleCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
			for (const region of computeBlitRegions(writeIndexRef.current, CANVAS_WIDTH)) {
				visibleCtx.drawImage(bufferCanvas, region.srcX, 0, region.width, CANVAS_HEIGHT, region.destX, 0, region.width, CANVAS_HEIGHT);
			}
		}

		function tick() {
			const graph = audioGraphRef.current;
			if (graph) {
				drawColumn(graph.getSpectrum());
				render();
				if (frame % LEVELS_EVERY_N_FRAMES === 0) setLevels(graph.getLevels());
			}
			frame++;
			raf = requestAnimationFrame(tick);
		}
		raf = requestAnimationFrame(tick);

		return () => cancelAnimationFrame(raf);
	}, [localStream]);

	if (!localStream) return null;

	return (
		<div class="room-audio-visualizer stack box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}>
			<canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} class="room-spectrogram" aria-hidden="true" />
			<label class="row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
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
