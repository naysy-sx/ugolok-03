import { useRef, useState } from "preact/hooks";
import { getManifest } from "../../domain/files/content.js";
import { getFileKeyFor, projected } from "../signals/files.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import FilePicker from "./file-picker.jsx";
import IconPaperclip from "../icons/paperclip.jsx";
import IconFolder from "../icons/folder.jsx";
import IconMicrophone from "../icons/microphone.jsx";
import IconStop from "../icons/stop.jsx";
import IconCross from "../icons/cross.jsx";
import { t, errorMessage } from "../signals/i18n.js";

const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Живой фидбег — единый набор кнопок прикрепления (файл/из хранилища/голос)
// для ВСЕХ трёх композиторов (личный чат — chat.jsx, комментарий и общий чат
// канала — channel-shared.jsx/channel-composer.jsx). Раньше в каждом был свой
// (усечённый) набор — визуально и функционально расходились. voice —
// useVoiceRecording() (use-voice-recording.js); без него кнопка микрофона не
// рендерится (на случай, если где-то голос всё же окажется не нужен).
export function ComposeAttachButtons({ tray, voice, disabled, onError }) {
	const fileInputRef = useRef(null);
	const [filePickerOpen, setFilePickerOpen] = useState(false);

	function handleFilesSelected(e) {
		// FileList из e.currentTarget.files — ЖИВАЯ ссылка на список инпута:
		// обнуление e.currentTarget.value ДО addFiles() опустошило бы её же
		// (тот же объект, не копия) — addFiles() должен уйти первым.
		const files = e.currentTarget.files;
		if (!files || files.length === 0) return;
		voice?.cancel();
		tray.addFiles(files);
		e.currentTarget.value = ""; // иначе повторный выбор ТЕХ ЖЕ файлов не даёт onChange
	}

	// Вложение ИЗ ХРАНИЛИЩА (FilePicker). Дедупликация (MATH.md §7: "передают
	// Digest блоба, а не копию байтов") — файл НЕ перезаливается заново под
	// новым ключом, дескриптор вложения ссылается на ТОТ ЖЕ manifestDigest/
	// fileKey узла. С момента отправки получатель(и) держат fileKey НАВСЕГДА —
	// отозвать нельзя, предупреждение — ДО обращения к хранилищу, простой
	// window.confirm() (тот же приём, что аватар/необратимые действия files.jsx).
	async function handleAttachmentFromStorage(ids) {
		setFilePickerOpen(false);
		if (!ids || ids.length === 0) return;
		if (!window.confirm(t("chat.window.sendAttachmentConfirm"))) return;
		const refs = [];
		let lastError = "";
		for (const id of ids) {
			const node = projected.value.nodes.get(id);
			if (!node || node.kind !== "file") continue;
			try {
				const manifest = await getManifest(node.blob, { serverUrl: BLOSSOM_SERVER_URL });
				const fileKey = await getFileKeyFor(node.blob);
				if (!fileKey) {
					lastError = t("chat.window.fileKeyNotFoundError");
					continue;
				}
				refs.push({ manifestDigest: node.blob, fileKey, manifest });
			} catch (err) {
				lastError = errorMessage(err);
			}
		}
		if (lastError) onError?.(lastError);
		if (refs.length === 0) return;
		voice?.cancel();
		tray.addFromStorage(refs);
	}

	function handleStartRecording() {
		tray.reset(); // взаимоисключение — начатая запись отменяет выбранные вложения
		voice.start();
	}

	return (
		<>
			<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFilesSelected} aria-hidden="true" tabIndex={-1} />
			<button type="button" class="message-compose-tool-btn" onClick={() => fileInputRef.current?.click()} disabled={disabled} aria-label={t("chat.window.attachFileAria")}>
				<IconPaperclip />
			</button>
			<button type="button" class="message-compose-tool-btn" onClick={() => setFilePickerOpen(true)} disabled={disabled} aria-label={t("chat.window.attachFromStorageAria")}>
				<IconFolder />
			</button>
			{voice && (
				<button
					type="button"
					class="message-compose-tool-btn"
					onClick={handleStartRecording}
					disabled={disabled || !voice.isIdle || tray.items.length > 0}
					aria-label={t("chat.window.recordVoiceAria")}
				>
					<IconMicrophone />
				</button>
			)}
			{filePickerOpen && <FilePicker predicate={() => true} multiple={true} onSelect={handleAttachmentFromStorage} onCancel={() => setFilePickerOpen(false)} />}
		</>
	);
}

// Статус записи/прослушивания голосового — отдельно от кнопок: рендерится НАД
// полем ввода (тот же приём, что раньше в chat.jsx), не внутри .compose-tools.
export function VoiceRecordingStatus({ voice }) {
	if (voice.recordingState === "recording") {
		return (
			<p class="row recording-status" style={{ "--gap": "var(--space-s)", "--align": "center" }} role="status">
				<span class="recording-dot" aria-hidden="true" /> {t("chat.window.recordingStatus")}
				<button type="button" onClick={voice.stop}>
					<IconStop /> {t("common.stop")}
				</button>
				<button type="button" onClick={voice.cancel}>
					<IconCross /> {t("contacts.cancelRequestButton")}
				</button>
			</p>
		);
	}
	if (voice.recordingState === "recorded" && voice.recordedVoiceUrl) {
		return (
			<p class="row recording-status" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<div class="audio-shell">
					<audio controls src={voice.recordedVoiceUrl} />
				</div>
				<button type="button" onClick={voice.discard}>
					<IconCross /> {t("chat.window.deleteRecordingButton")}
				</button>
			</p>
		);
	}
	return null;
}
