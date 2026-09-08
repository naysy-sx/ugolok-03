import { useEffect, useRef, useState } from "preact/hooks";
import { callState, localMediaStream, remoteMediaStream, acceptCall, rejectCall, hangupCall, dismissEndedCall } from "../signals/call.js";
import { profiles } from "../signals/contacts.js";
import IconPhoneCall from "../icons/phone-call.jsx";
import { RINGTONE_DATA_URI } from "../../domain/calls/ringtone-asset.js";
import { t } from "../signals/i18n.js";
import { isTraceEnabled, record as traceRecord } from "../../core/diag/call-trace.js";
import { RESTART_PHASE1_END_MS } from "../../domain/calls/call-fsm.js";

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

		// TZ-diag-trace.md §2.6 — состояние AudioContext раз в 10с. Это контекст
		// АНАЛИЗАТОРА волны (визуализация), не путь воспроизведения (RemoteAudio
		// ниже — обычный <audio>) — тем не менее тот же движок, тот же браузерный
		// suspend/resume, и единственный AudioContext, до которого дотягивается
		// звонковый UI. Подписка создаётся, только если флаг уже включён.
		let audioStateInterval = null;
		if (isTraceEnabled()) {
			audioStateInterval = setInterval(() => traceRecord("audio-context", { state: audioCtx.state }), 10000);
		}

		return () => {
			cancelAnimationFrame(raf);
			if (audioStateInterval) clearInterval(audioStateInterval);
			source.disconnect();
			audioCtx.close().catch(() => {});
		};
	}, [stream]);

	return <canvas ref={canvasRef} width={120} height={28} class="call-waveform" aria-hidden="true" />;
}

// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (живое использование) — звука не было ВООБЩЕ: track
// собеседника доходил (ontrack в media-controller.js), стрим сохранялся в
// remoteMediaStream, но нигде реально НЕ проигрывался — Waveform выше только
// АНАЛИЗИРУЕТ поток (AnalyserNode), не воспроизводит его. Без явного <audio>
// с srcObject звук так и не звучит, сколько разрешений браузеру ни давай.
// muted — TZ-recovery-policy.md §6: во время RECONNECTING собственный микрофон
// НЕ трогаем (см. media-controller.js doIceRestart — трек живёт между
// попытками), а вот воспроизведение собеседника глушим здесь, в UI: пока ICE
// разорван, remoteMediaStream всё ещё держит СТАРЫЙ MediaStream (иногда с
// последним, уже неактуальным кадром/остатком буфера) — явный mute убирает
// любой шанс призрачного звука до реального восстановления медиапотока.
function RemoteAudio({ stream, muted = false }) {
	const audioRef = useRef(null);
	useEffect(() => {
		const el = audioRef.current;
		if (!el || !stream) return;
		el.srcObject = stream;
		el.play().catch(() => {}); // автоплей может потребовать жеста — клик "Принять"/"Позвонить" его уже дал
		return () => {
			el.srcObject = null;
		};
	}, [stream]);
	return <audio ref={audioRef} autoPlay muted={muted} style={{ display: "none" }} />;
}

// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (живое использование) — во время дозвона не звучало
// НИЧЕГО ни у звонящего (OUTGOING_RINGING, гудки/ринг-бэк), ни у принимающего
// (INCOMING_RINGING, рингтон) — RemoteAudio выше начинает проигрывать голос
// собеседника только ПОСЛЕ CONNECTED, до этого момента полная тишина. Один и
// тот же файл на обеих сторонах (пользователь подтвердил), зациклен нативным
// loop — не нужен JS-таймер перезапуска. Компонент монтируется ТОЛЬКО внутри
// ветки рендера RINGING (см. ниже) — переход в любое другое состояние
// размонтирует его вместе со всей веткой, что само по себе останавливает звук
// (cleanup эффекта), без отдельной логики "стоп по состоянию".
function RingtoneAudio() {
	const audioRef = useRef(null);
	useEffect(() => {
		const el = audioRef.current;
		if (!el) return;
		el.play().catch(() => {}); // автоплей может потребовать жеста — тот же принцип, что RemoteAudio
		return () => {
			el.pause();
		};
	}, []);
	return <audio ref={audioRef} src={RINGTONE_DATA_URI} loop style={{ display: "none" }} />;
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

// TZ-recovery-policy.md §1/§6 — две под-фазы RECONNECTING для UI: "короткая"
// (секундомер, часто напоминает — сбой ещё выглядит как обычный обрыв) и
// "длинная" (после RESTART_PHASE1_END_MS — та же граница, что call-fsm.js
// использует для роста интервала попыток, §2.2 — переиспользуем её же, не
// заводим отдельную). НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (10-LIVE-INCIDENT §... "звонок
// компьютера самому себе"): реконнект визуально путался с исходящим вызовом —
// здесь отдельная, узнаваемая плашка (не переиспользует call-overlay-ringing).
function ReconnectPanel({ since }) {
	const [, forceTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => forceTick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, []);
	const elapsedMs = Math.max(0, Date.now() - since);
	const isLong = elapsedMs >= RESTART_PHASE1_END_MS;
	// Заголовок ("Переподключение…", строка ниже в CallOverlay) уже называет
	// происходящее — короткая фаза добавляет только секундомер (не дублирует
	// текст словами), длинная фаза заменяет секундомер спокойным пояснением
	// (§6 — тикающий счётчик в длинной фазе создавал бы ложное ощущение спешки).
	if (isLong) {
		return <span class="call-bar-reconnect-note">{t("call.reconnectingLong")}</span>;
	}
	const seconds = Math.floor(elapsedMs / 1000);
	const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
	const ss = String(seconds % 60).padStart(2, "0");
	return (
		<span class="call-bar-reconnect-stopwatch">
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

	// TZ-recovery-policy.md §6 — метка "с какого момента идёт восстановление"
	// нужна ТОЛЬКО для секундомера в UI; FSM (call-fsm.js) её не хранит по той
	// же причине, что и connectedAtRef выше — временные метки живут в UI, не в
	// автомате (VOICE.md §1.2, "заморожено"). call-runtime.js считает свой
	// собственный reconnectingStartedAt для логики (RESTART_TICK), это
	// НЕЗАВИСИМАЯ копия для отображения — раздельные конкретные требования
	// (§2 логика восстановления vs §6 отображение), совпадение по смыслу, не по коду.
	const reconnectingSinceRef = useRef(null);
	if (call.name === "RECONNECTING" && reconnectingSinceRef.current === null) {
		reconnectingSinceRef.current = Date.now();
	}
	if (call.name !== "RECONNECTING") {
		reconnectingSinceRef.current = null;
	}

	// ENDED — краткая справка; call-runtime.js сам возвращает FSM в IDLE спустя
	// пару секунд (см. call-runtime.js — "после очистки ресурсов", VOICE.md
	// §1.1), но НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ: до этого фикса не возвращал вовсе, плашка
	// висела бесконечно — крестик даёт закрыть сразу, не дожидаясь автовозврата.
	if (call.name === "ENDED") {
		return (
			<div class="call-overlay call-overlay-ended row" style={{ "--gap": "var(--space-s)", "--align": "center", justifyContent: "center" }} role="status" aria-live="polite">
				<p>{call.reason ? t("call.endedWithReason", { reason: callEndReasonLabel(call.reason) }) : t("call.ended")}</p>
				<button type="button" class="call-overlay-ended-close" onClick={dismissEndedCall} aria-label={t("common.close")}>
					×
				</button>
			</div>
		);
	}

	if (call.name === "IDLE") return null;

	if (call.name === "OUTGOING_RINGING" || call.name === "INCOMING_RINGING") {
		const incoming = call.name === "INCOMING_RINGING";
		return (
			<div
				class="call-overlay call-overlay-ringing stack"
				style={{ "--gap": "var(--space-s)", "--align": "center" }}
				role="dialog"
				aria-modal="true"
				aria-label={incoming ? t("call.incomingAria") : t("call.outgoingAria")}
			>
				<RingtoneAudio />
				<div class="call-overlay-avatar row" style={{ "--align": "center", justifyContent: "center" }} aria-hidden="true">
					{(displayName(call.peerPubkey) || "?").trim().charAt(0).toUpperCase()}
				</div>
				<p class="call-overlay-title">
					{incoming ? t("call.incomingFrom", { name: displayName(call.peerPubkey) }) : t("call.callingTo", { name: displayName(call.peerPubkey) })}
				</p>
				<div class="row" style={{ "--gap": "var(--space-s)", justifyContent: "center" }}>
					{incoming ? (
						<>
							<button type="button" class="call-btn-accept" onClick={acceptCall}>
								{t("contacts.acceptButton")}
							</button>
							<button type="button" class="call-btn-reject" onClick={rejectCall}>
								{t("contacts.rejectButton")}
							</button>
						</>
					) : (
						<button type="button" class="call-btn-reject" onClick={hangupCall}>
							{t("contacts.cancelRequestButton")}
						</button>
					)}
				</div>
			</div>
		);
	}

	if (call.name === "CONNECTING") {
		return (
			<div class="call-overlay call-overlay-ringing stack" style={{ "--gap": "var(--space-s)", "--align": "center" }} role="status" aria-live="polite">
				<p class="call-overlay-title">{t("call.connectingTo", { name: displayName(call.peerPubkey) })}</p>
			</div>
		);
	}

	// CONNECTED / RECONNECTING — компактная закреплённая плашка, не мешает
	// остальному интерфейсу (пользователь может листать другие разделы во время звонка).
	const reconnecting = call.name === "RECONNECTING";
	return (
		<div class={`call-bar row${reconnecting ? " call-bar-reconnecting" : ""}`} style={{ "--gap": "var(--space-s)", "--align": "center" }} role="status" aria-live="polite">
			<div class="call-bar-avatar row" style={{ "--align": "center", justifyContent: "center" }} aria-hidden="true">
				{(displayName(call.peerPubkey) || "?").trim().charAt(0).toUpperCase()}
			</div>
			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<strong>{reconnecting ? t("call.reconnectingTitle") : t("call.connectedWith", { name: displayName(call.peerPubkey) })}</strong>
				{reconnecting && reconnectingSinceRef.current && <ReconnectPanel since={reconnectingSinceRef.current} />}
				{!reconnecting && connectedAtRef.current && (
					<span class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<CallDuration startedAt={connectedAtRef.current} />
						<Waveform stream={remoteMediaStream.value || localMediaStream.value} />
					</span>
				)}
			</div>
			<RemoteAudio stream={remoteMediaStream.value} muted={reconnecting} />
			<button
				type="button"
				class="call-btn-reject call-bar-hangup row"
				style={{ "--align": "center", justifyContent: "center" }}
				onClick={hangupCall}
				aria-label={t("call.hangupAria")}
			>
				<IconPhoneCall />
			</button>
		</div>
	);
}

const CALL_END_REASON_KEYS = {
	no_answer: "call.reason.noAnswer",
	missed: "call.reason.missed",
	rejected: "call.reason.rejected",
	cancelled: "call.reason.cancelled",
	cancelled_by_caller: "call.reason.cancelledByCaller",
	connect_failed: "call.reason.connectFailed",
	hangup: "call.reason.hangup",
	remote_hangup: "call.reason.remoteHangup",
	// TZ-recovery-policy.md §1 — "connection_lost" как причина завершения
	// убрана из call-fsm.js: потеря сети сама по себе больше никогда не
	// завершает звонок (только §2.4 safety_cap или §3 peer_gone). Ключ/перевод
	// оставлены — старые записи трассы/логов ссылаются на него, и это чистая
	// текстовая таблица, а не код: удалять нечего исправлять.
	connection_lost: "call.reason.connectionLost",
	peer_gone: "call.reason.peerGone",
	safety_cap: "call.reason.safetyCap",
};

function callEndReasonLabel(reason) {
	return CALL_END_REASON_KEYS[reason] ? t(CALL_END_REASON_KEYS[reason]) : reason;
}
