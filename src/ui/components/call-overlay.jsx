import { useEffect, useRef, useState } from "preact/hooks";
import { callState, localMediaStream, remoteMediaStream, acceptCall, rejectCall, hangupCall } from "../signals/call.js";
import { profiles } from "../signals/contacts.js";
import IconPhoneCall from "../icons/phone-call.jsx";

// Этап 48, п.6 — persistent-компонент уровня app.jsx (тот же архитектурный
// принцип, что ToastHost, этап 47): входящий звонок обязан быть виден с ЛЮБОГО
// экрана, идущий звонок остаётся на экране, пока пользователь листает другие
// разделы. Один компонент, четыре визуальных режима по callState.value.name.

function displayName(pubkey) {
	if (!pubkey) return "";
	return profiles.value[pubkey]?.name?.trim() || `${pubkey.slice(0, 8)}…`;
}

// Волновая визуализация (предложение пользователя) — Web Audio AnalyserNode,
// нативный API, без библиотек (бюджет NF-11 не страдает).
function Waveform({ stream }) {
	const canvasRef = useRef(null);

	useEffect(() => {
		if (!stream || !canvasRef.current) return;
		const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
		if (!AudioContextImpl) return;
		const audioCtx = new AudioContextImpl();
		const source = audioCtx.createMediaStreamSource(stream);
		const analyser = audioCtx.createAnalyser();
		analyser.fftSize = 64;
		source.connect(analyser);
		const data = new Uint8Array(analyser.frequencyBinCount);
		const barColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4a90d9";
		let raf;

		function draw() {
			analyser.getByteFrequencyData(data);
			const canvas = canvasRef.current;
			if (!canvas) return;
			const ctx = canvas.getContext("2d");
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			const barWidth = canvas.width / data.length;
			ctx.fillStyle = barColor;
			for (let i = 0; i < data.length; i++) {
				const barHeight = Math.max(1, (data[i] / 255) * canvas.height);
				ctx.fillRect(i * barWidth, canvas.height - barHeight, Math.max(1, barWidth - 1), barHeight);
			}
			raf = requestAnimationFrame(draw);
		}
		draw();

		return () => {
			cancelAnimationFrame(raf);
			source.disconnect();
			audioCtx.close().catch(() => {});
		};
	}, [stream]);

	return <canvas ref={canvasRef} width={120} height={28} class="call-waveform" aria-hidden="true" />;
}

// Тикающий таймер длительности — callState (FSM) не несёт временных меток (§1.2
// VOICE.md заморожен, не трогаем), поэтому "с какого момента считать" живёт
// здесь, локально в UI, а не в состоянии автомата.
function CallDuration({ startedAt }) {
	const [, forceTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => forceTick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, []);
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
	const ss = String(seconds % 60).padStart(2, "0");
	return (
		<span>
			{mm}:{ss}
		</span>
	);
}

export default function CallOverlay() {
	const call = callState.value;
	const connectedAtRef = useRef(null);
	if (call.name === "CONNECTED" && connectedAtRef.current === null) {
		connectedAtRef.current = Date.now();
	}
	if (call.name === "IDLE" || call.name === "ENDED") {
		connectedAtRef.current = null;
	}

	// ENDED — краткая справка (переиспользуем визуальный язык тоста), затем
	// уходит сама (call-runtime.js вернёт FSM в IDLE новым звонком, не таймером —
	// оверлей просто перестаёт себя показывать после короткой паузы).
	if (call.name === "ENDED") {
		return (
			<div class="call-overlay call-overlay-ended" role="status" aria-live="polite">
				<p>Звонок завершён{call.reason ? `: ${callEndReasonRu(call.reason)}` : ""}</p>
			</div>
		);
	}

	if (call.name === "IDLE") return null;

	if (call.name === "OUTGOING_RINGING" || call.name === "INCOMING_RINGING") {
		const incoming = call.name === "INCOMING_RINGING";
		return (
			<div class="call-overlay call-overlay-ringing" role="dialog" aria-modal="true" aria-label={incoming ? "Входящий звонок" : "Исходящий звонок"}>
				<div class="call-overlay-avatar" aria-hidden="true">
					{(displayName(call.peerPubkey) || "?").trim().charAt(0).toUpperCase()}
				</div>
				<p class="call-overlay-title">
					{incoming ? `Входящий звонок от ${displayName(call.peerPubkey)}` : `Звоним ${displayName(call.peerPubkey)}…`}
				</p>
				<div class="cluster" style={{ justifyContent: "center" }}>
					{incoming ? (
						<>
							<button type="button" class="call-btn-accept" onClick={acceptCall}>
								Принять
							</button>
							<button type="button" class="call-btn-reject" onClick={rejectCall}>
								Отклонить
							</button>
						</>
					) : (
						<button type="button" class="call-btn-reject" onClick={hangupCall}>
							Отменить
						</button>
					)}
				</div>
			</div>
		);
	}

	if (call.name === "CONNECTING") {
		return (
			<div class="call-overlay call-overlay-ringing" role="status" aria-live="polite">
				<p class="call-overlay-title">Соединение с {displayName(call.peerPubkey)}…</p>
			</div>
		);
	}

	// CONNECTED / RECONNECTING — компактная закреплённая плашка, не мешает
	// остальному интерфейсу (пользователь может листать другие разделы во время звонка).
	const reconnecting = call.name === "RECONNECTING";
	return (
		<div class={`call-bar${reconnecting ? " call-bar-reconnecting" : ""}`} role="status" aria-live="polite">
			<div class="call-bar-avatar" aria-hidden="true">
				{(displayName(call.peerPubkey) || "?").trim().charAt(0).toUpperCase()}
			</div>
			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<strong>{reconnecting ? "Переподключение…" : `Связь с ${displayName(call.peerPubkey)}`}</strong>
				{!reconnecting && connectedAtRef.current && (
					<span class="cluster" style={{ alignItems: "center" }}>
						<CallDuration startedAt={connectedAtRef.current} />
						<Waveform stream={remoteMediaStream.value || localMediaStream.value} />
					</span>
				)}
			</div>
			<button type="button" class="call-btn-reject call-bar-hangup" onClick={hangupCall} aria-label="Завершить звонок">
				<IconPhoneCall />
			</button>
		</div>
	);
}

function callEndReasonRu(reason) {
	const map = {
		no_answer: "не ответили",
		missed: "пропущен",
		rejected: "отклонён",
		cancelled: "отменён",
		cancelled_by_caller: "отменён звонящим",
		connect_failed: "не удалось соединиться",
		hangup: "завершён вами",
		remote_hangup: "завершён собеседником",
		connection_lost: "связь потеряна",
	};
	return map[reason] || reason;
}
