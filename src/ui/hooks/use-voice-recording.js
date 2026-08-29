import { useState, useRef, useEffect } from "preact/hooks";
import { createVoiceRecorder, shouldInlineVoice } from "../../domain/messaging/voice.js";
import { uploadMessageAttachment } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { t, errorMessage } from "../signals/i18n.js";

const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function base64FromBytes(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

// Живой фидбег — вынесено из chat.jsx (была единственным местом с голосовыми
// сообщениями), чтобы CommentComposer/ChannelComposer могли предложить ту же
// возможность без копипасты state-машины idle->recording->recorded.
export function useVoiceRecording() {
	const [recordingState, setRecordingState] = useState("idle");
	const [recordedVoiceBlob, setRecordedVoiceBlob] = useState(null);
	const [recordedVoiceUrl, setRecordedVoiceUrl] = useState(null);
	const [error, setError] = useState("");
	const voiceRecorderRef = useRef(null);

	useEffect(() => {
		if (!recordedVoiceBlob) {
			setRecordedVoiceUrl(null);
			return;
		}
		const url = URL.createObjectURL(recordedVoiceBlob);
		setRecordedVoiceUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [recordedVoiceBlob]);

	async function start() {
		setError("");
		const recorder = createVoiceRecorder();
		try {
			await recorder.start();
			voiceRecorderRef.current = recorder;
			setRecordingState("recording");
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	async function stop() {
		if (!voiceRecorderRef.current) return;
		try {
			const blob = await voiceRecorderRef.current.stop();
			setRecordedVoiceBlob(blob);
			setRecordingState("recorded");
		} catch (err) {
			setError(errorMessage(err));
			setRecordingState("idle");
		} finally {
			voiceRecorderRef.current = null;
		}
	}

	// Начатая запись отменяет уже выбранные файловые вложения — вызывающий
	// код обязан сам звать tray.reset() рядом (взаимоисключение — то же, что
	// раньше было завязано внутри chat.jsx вручную).
	function cancel() {
		voiceRecorderRef.current?.cancel();
		voiceRecorderRef.current = null;
		setRecordingState("idle");
		setRecordedVoiceBlob(null);
	}

	function discard() {
		setRecordedVoiceBlob(null);
		setRecordingState("idle");
	}

	// После успешной отправки — то же, что cancel(), но семантически "всё ушло",
	// а не "пользователь передумал". Поведение идентично, разделено ради читаемости
	// вызывающего кода (reset() в handleSubmit, cancel() в UI-кнопке "отмена").
	function reset() {
		voiceRecorderRef.current?.cancel();
		voiceRecorderRef.current = null;
		setRecordingState("idle");
		setRecordedVoiceBlob(null);
	}

	// undefined, если нечего прикреплять (recordingState !== "recorded") — тот же
	// контракт, что buildOutgoingAttachments() в chat.jsx раньше. Голосовое
	// ≤32КБ — inline base64 прямо в сообщении, иначе — обычная загрузка на Blossom.
	async function buildAttachment(privKey) {
		if (!recordedVoiceBlob) return undefined;
		const bytes = new Uint8Array(await recordedVoiceBlob.arrayBuffer());
		if (shouldInlineVoice(bytes.length)) {
			return { type: "audio", voice: true, mime: "audio/webm", name: t("chat.voiceMessageName"), size: bytes.length, voiceInline: base64FromBytes(bytes) };
		}
		const descriptor = await uploadMessageAttachment(BLOSSOM_SERVER_URL, bytes, { mime: "audio/webm", name: t("chat.voiceMessageName") }, privKey);
		descriptor.voice = true;
		return descriptor;
	}

	return {
		recordingState,
		recordedVoiceUrl,
		error,
		isIdle: recordingState === "idle",
		hasRecording: recordingState === "recorded",
		start,
		stop,
		cancel,
		discard,
		reset,
		buildAttachment,
	};
}
