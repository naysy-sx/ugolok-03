import { useState, useEffect } from "preact/hooks";
import { downloadAttachment } from "../../domain/attachments/upload.js";
import ImageModal from "./image-modal.jsx";

function base64ToBytes(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function formatFileSize(bytes) {
	if (bytes < 1024) return `${bytes} Б`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

const FILE_TYPE_ICONS = { video: "🎞️", audio: "🎵", file: "📄" };

// Картинка — EAGER-загрузка+расшифровка (не может быть иначе: E2E-шифрование не даёт
// частичной/потоковой подгрузки, нужно скачать и расшифровать ПОЛНОСТЬЮ, прежде чем
// показать хоть пиксель) — но картинки ожидаются видимыми сразу в бабле (в отличие от
// видео, см. VideoAttachment), клик -> полноэкранная модалка (image-modal.jsx).
function ImageAttachment({ attachment }) {
	const [url, setUrl] = useState(null);
	const [error, setError] = useState("");
	const [showModal, setShowModal] = useState(false);

	useEffect(() => {
		let cancelled = false;
		let objectUrl;
		downloadAttachment(attachment)
			.then((bytes) => {
				if (cancelled) return;
				objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
				setUrl(objectUrl);
			})
			.catch((err) => {
				if (!cancelled) setError(err?.message || String(err));
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [attachment]);

	if (error) {
		return (
			<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
				Не удалось загрузить картинку: {error}
			</p>
		);
	}
	if (!url) return <p style={{ color: "var(--muted)" }}>Загрузка картинки…</p>;

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

// Аудио/голосовое — тоже eager (лимит F-AT-04 всего 3 МБ, в отличие от видео/картинок
// до 20 МБ — цена автозагрузки много ниже). voiceInline (F-AT-08, ≤32КБ) вообще не ходит
// в сеть — декодируется прямо из base64 в payload сообщения.
function AudioAttachment({ attachment }) {
	const [url, setUrl] = useState(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		let objectUrl;
		if (attachment.voiceInline) {
			objectUrl = URL.createObjectURL(new Blob([base64ToBytes(attachment.voiceInline)], { type: attachment.mime || "audio/webm" }));
			setUrl(objectUrl);
			return () => URL.revokeObjectURL(objectUrl);
		}
		downloadAttachment(attachment)
			.then((bytes) => {
				if (cancelled) return;
				objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
				setUrl(objectUrl);
			})
			.catch((err) => {
				if (!cancelled) setError(err?.message || String(err));
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [attachment]);

	if (error) {
		return (
			<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
				Не удалось загрузить аудио: {error}
			</p>
		);
	}
	if (!url) return <p style={{ color: "var(--muted)" }}>Загрузка{attachment.voice ? " голосового" : " аудио"}…</p>;
	return <audio controls src={url} />;
}

// Видео — ЛЕНИВАЯ загрузка по клику (до 20 МБ; автозагрузка каждого видео в истории
// чата была бы избыточной — в отличие от картинок, которые ожидаются видимыми сразу).
function VideoAttachment({ attachment }) {
	const [url, setUrl] = useState(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	function handleLoad() {
		setLoading(true);
		setError("");
		downloadAttachment(attachment)
			.then((bytes) => {
				setUrl(URL.createObjectURL(new Blob([bytes], { type: attachment.mime })));
			})
			.catch((err) => setError(err?.message || String(err)))
			.finally(() => setLoading(false));
	}

	useEffect(() => {
		return () => {
			if (url) URL.revokeObjectURL(url);
		};
	}, [url]);

	if (url) {
		return <video controls autoPlay src={url} style={{ maxWidth: "100%", borderRadius: "var(--radius)", display: "block" }} />;
	}

	return (
		<p class="cluster" style={{ alignItems: "center" }}>
			<span aria-hidden="true">{FILE_TYPE_ICONS.video}</span>
			<span>
				{attachment.name} ({formatFileSize(attachment.size)})
			</span>
			<button type="button" onClick={handleLoad} disabled={loading}>
				{loading ? "Загрузка…" : "Воспроизвести"}
			</button>
			{error && (
				<small role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</small>
			)}
		</p>
	);
}

// Файл (не image/video/audio — документ/таблица/архив) — НИКОГДА не скачивается
// автоматически, только по явному клику "Скачать".
function FileAttachment({ attachment }) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	async function handleDownload() {
		setLoading(true);
		setError("");
		try {
			const bytes = await downloadAttachment(attachment);
			const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
			const a = document.createElement("a");
			a.href = url;
			a.download = attachment.name || "file";
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			setLoading(false);
		}
	}

	return (
		<p class="cluster" style={{ alignItems: "center" }}>
			<span aria-hidden="true">{FILE_TYPE_ICONS.file}</span>
			<span>
				{attachment.name} ({formatFileSize(attachment.size)})
			</span>
			<button type="button" onClick={handleDownload} disabled={loading}>
				{loading ? "Скачивание…" : "Скачать"}
			</button>
			{error && (
				<small role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</small>
			)}
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
