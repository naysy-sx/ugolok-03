import { useState, useEffect } from "preact/hooks";
import { getOrDownloadMessageAttachment } from "../../domain/files/content-cache.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../attachment-memory-cache.js";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import ImageModal from "./image-modal.jsx";
import IconMusicNote from "../icons/music-note.jsx";
import IconVideoCamera from "../icons/video-camera.jsx";
import IconFileText from "../icons/file-text.jsx";
import IconImage from "../icons/image-icon.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// Этап 53 И7 7.4 — дескриптор вложения больше не несёт СВОЙ blossomUrl (старая
// форма, на сервер, куда конкретно загружено); manifestDigest/fileKey читаются
// через content.js — тот же ОДИН сконфигурированный Blossom-сервер, что везде
// в разделе "Файлы" (files.jsx/file-player.jsx), не per-вложение URL.
const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function base64ToBytes(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function formatFileSize(bytes) {
	if (bytes < 1024) return t("attachment.units.bytes", { count: bytes });
	if (bytes < 1024 * 1024) return t("attachment.units.kb", { count: (bytes / 1024).toFixed(1) });
	return t("attachment.units.mb", { count: (bytes / (1024 * 1024)).toFixed(1) });
}

// voice (F-AT-08) — имя вложения не годится для отображения: оно приходит
// зашифрованным ВНУТРИ сообщения от отправителя буквальным текстом на ЕГО
// языке (см. chat.jsx buildOutgoingAttachment) — получатель не может
// "перевести" чужие данные через свой t(). Вместо этого для голосовых вообще
// игнорируем attachment.name и показываем нейтральную подпись на языке
// ПРОСМАТРИВАЮЩЕГО, определяя голосовое по флагу attachment.voice (уже
// существующее булево поле, не зависит от текста).
function attachmentDisplayName(attachment) {
	return attachment.voice ? t("chat.voiceMessageName") : attachment.name;
}

const FILE_TYPE_ICONS = { image: IconImage, video: IconVideoCamera, audio: IconMusicNote, file: IconFileText };

// Картинка — EAGER-загрузка+расшифровка (не может быть иначе: E2E-шифрование не даёт
// частичной/потоковой подгрузки, нужно скачать и расшифровать ПОЛНОСТЬЮ, прежде чем
// показать хоть пиксель) — но картинки ожидаются видимыми сразу в бабле (в отличие от
// видео, см. VideoAttachment), клик -> полноэкранная модалка (image-modal.jsx).
function ImageAttachment({ attachment }) {
	// Ленивая инициализация из общего слоя памяти (attachment-memory-cache.js) —
	// если картинку уже показывали в этой вкладке, url есть СРАЗУ на первом рендере,
	// без вспышки спиннера (найдено ревью: URL.revokeObjectURL на каждом unmount
	// раньше заставлял пере-качивать и пере-расшифровывать уже виденное).
	const [url, setUrl] = useState(() => getMemoryCachedUrl(attachment.manifestDigest) ?? null);
	const [error, setError] = useState("");
	const [showModal, setShowModal] = useState(false);

	useEffect(() => {
		const memUrl = getMemoryCachedUrl(attachment.manifestDigest);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: BLOSSOM_URL })
			.then((bytes) => {
				if (cancelled) return;
				setUrl(putMemoryCachedAttachment(attachment.manifestDigest, bytes, attachment.mime));
			})
			.catch((err) => {
				if (!cancelled) setError(errorMessage(err));
			});
		// URL НЕ отзывается здесь — им теперь владеет attachment-memory-cache.js
		// (вытесняется по LRU/бюджету или полностью в lock()), не жизненный цикл
		// этого конкретного компонента.
		return () => {
			cancelled = true;
		};
	}, [attachment]);

	if (error) {
		return (
			<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
				{t("attachment.imageLoadError", { error })}
			</p>
		);
	}
	if (!url) {
		return (
			<p class="cluster" style={{ alignItems: "center", color: "var(--muted)" }}>
				<span class="spinner" aria-hidden="true" /> {t("attachment.loadingImage")}
			</p>
		);
	}

	return (
		<>
			<img
				src={url}
				alt={attachment.name || ""}
				onClick={() => setShowModal(true)}
				style={{ maxWidth: "100%", maxHeight: "16rem", borderRadius: "var(--radius)", cursor: "pointer", display: "block" }}
			/>
			{showModal && <ImageModal src={url} alt={attachment.name} onClose={() => setShowModal(false)} />}
		</>
	);
}

// Аудио/голосовое — тоже eager (F-AT-04, этап 29-довесок: тот же потолок 50 МБ, что
// видео — раньше был отдельный лимит 3 МБ, поднят по просьбе пользователя). voiceInline
// (F-AT-08, ≤32КБ) вообще не ходит в сеть — декодируется прямо из base64 в payload.
function AudioAttachment({ attachment }) {
	const [url, setUrl] = useState(() => (attachment.voiceInline ? null : (getMemoryCachedUrl(attachment.manifestDigest) ?? null)));
	const [error, setError] = useState("");

	useEffect(() => {
		// voiceInline (≤32КБ, F-AT-08) — decode из payload КАЖДЫЙ раз, в сеть/кэш
		// не ходит вовсе, кэшировать нечего (уже дёшево, ObjectURL живёт своим
		// unmount'ом, как раньше).
		if (attachment.voiceInline) {
			const objectUrl = URL.createObjectURL(new Blob([base64ToBytes(attachment.voiceInline)], { type: attachment.mime || "audio/webm" }));
			setUrl(objectUrl);
			return () => URL.revokeObjectURL(objectUrl);
		}
		const memUrl = getMemoryCachedUrl(attachment.manifestDigest);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: BLOSSOM_URL })
			.then((bytes) => {
				if (cancelled) return;
				setUrl(putMemoryCachedAttachment(attachment.manifestDigest, bytes, attachment.mime));
			})
			.catch((err) => {
				if (!cancelled) setError(errorMessage(err));
			});
		return () => {
			cancelled = true;
		};
	}, [attachment]);

	if (error) {
		return (
			<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
				{t("attachment.audioLoadError", { error })}
			</p>
		);
	}
	if (!url) {
		return (
			<p class="cluster" style={{ alignItems: "center", color: "var(--muted)" }}>
				<span class="spinner" aria-hidden="true" /> {attachment.voice ? t("attachment.loadingVoice") : t("attachment.loadingAudio")}
			</p>
		);
	}
	return <audio controls src={url} />;
}

// Видео — EAGER-загрузка (item 9, пользователь: "не надо кнопку, пусть сразу
// файл отображается"), тот же приём, что ImageAttachment. autoPlay убран
// НАРОЧНО: при входе в чат с несколькими уже загруженными (закэшированными
// в памяти) видео все они рендерятся одновременно — с autoPlay они играли бы
// хором ("сливаются в какофонию", живая проверка пользователя); без autoPlay
// каждое видео просто показывает первый кадр, воспроизведение — по клику на
// нативные controls, как и ожидается от обычного плеера.
function VideoAttachment({ attachment }) {
	const [url, setUrl] = useState(() => getMemoryCachedUrl(attachment.manifestDigest) ?? null);
	const [error, setError] = useState("");

	useEffect(() => {
		const memUrl = getMemoryCachedUrl(attachment.manifestDigest);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: BLOSSOM_URL })
			.then((bytes) => {
				if (cancelled) return;
				setUrl(putMemoryCachedAttachment(attachment.manifestDigest, bytes, attachment.mime));
			})
			.catch((err) => {
				if (!cancelled) setError(errorMessage(err));
			});
		return () => {
			cancelled = true;
		};
	}, [attachment]);

	if (error) {
		return (
			<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
				{t("attachment.videoLoadError", { error })}
			</p>
		);
	}
	if (!url) {
		return (
			<p class="cluster" style={{ alignItems: "center", color: "var(--muted)" }}>
				<span class="spinner" aria-hidden="true" /> {t("attachment.loadingVideo")}
			</p>
		);
	}
	return <video controls src={url} style={{ maxWidth: "100%", borderRadius: "var(--radius)", display: "block" }} />;
}

// Файл (не image/video/audio — документ/таблица) — статичная строка с
// иконкой/именем/размером; скачивание теперь единой ссылкой "Скачать" в
// футере сообщения (message-bubble.jsx, item 10), не отдельной кнопкой тут.
function FileAttachment({ attachment }) {
	const Icon = FILE_TYPE_ICONS.file;
	return (
		<p class="cluster" style={{ alignItems: "center" }}>
			<Icon aria-hidden="true" />
			<span>
				{attachment.name} ({formatFileSize(attachment.size)})
			</span>
		</p>
	);
}

// Диспетчер по attachment.type (F-AT-02) — единственная точка входа для рендера
// вложения, переиспользуется message-bubble.jsx; задел на будущий раздел "мои файлы"
// (тот же дескриптор, та же отрисовка по типу).
export default function AttachmentView({ attachment }) {
	if (attachment.type === "image") return <ImageAttachment attachment={attachment} />;
	if (attachment.type === "video") return <VideoAttachment attachment={attachment} />;
	if (attachment.type === "audio") return <AudioAttachment attachment={attachment} />;
	return <FileAttachment attachment={attachment} />;
}

// Единая ссылка "Скачать" (item 10, "ко всем вложениям... перед 'Удалить'") —
// используется message-bubble.jsx в футере сообщения, ДО кнопки "Удалить".
// Формат: {{иконка типа}} Скачать {{имя}} ({{размер}}). voiceInline (F-AT-08,
// ≤32КБ) декодируется прямо из payload, без сети — как AudioAttachment.
export function AttachmentDownloadLink({ attachment }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const Icon = FILE_TYPE_ICONS[attachment.type] || IconFileText;

	async function handleDownload() {
		setBusy(true);
		setError("");
		try {
			const bytes = attachment.voiceInline
				? base64ToBytes(attachment.voiceInline)
				: await getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: BLOSSOM_URL });
			const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
			const a = document.createElement("a");
			a.href = url;
			a.download = attachmentDisplayName(attachment) || "file";
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<button type="button" onClick={handleDownload} disabled={busy}>
				<Icon /> {busy ? t("attachment.downloading") : t("attachment.download")} {attachmentDisplayName(attachment)} ({formatFileSize(attachment.size)})
			</button>
			{error && (
				<small role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</small>
			)}
		</>
	);
}
