import { useState, useEffect } from "preact/hooks";
import { getOrDownloadAttachment } from "../../domain/attachments/cache.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../attachment-memory-cache.js";
import { currentUser, dbKeySig } from "../signals/auth.js";
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
	// Ленивая инициализация из общего слоя памяти (attachment-memory-cache.js) —
	// если картинку уже показывали в этой вкладке, url есть СРАЗУ на первом рендере,
	// без вспышки спиннера (найдено ревью: URL.revokeObjectURL на каждом unmount
	// раньше заставлял пере-качивать и пере-расшифровывать уже виденное).
	const [url, setUrl] = useState(() => getMemoryCachedUrl(attachment.sha256) ?? null);
	const [error, setError] = useState("");
	const [showModal, setShowModal] = useState(false);

	useEffect(() => {
		const memUrl = getMemoryCachedUrl(attachment.sha256);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadAttachment(currentUser.value.id, dbKeySig.value, attachment)
			.then((bytes) => {
				if (cancelled) return;
				setUrl(putMemoryCachedAttachment(attachment.sha256, bytes, attachment.mime));
			})
			.catch((err) => {
				if (!cancelled) setError(err?.message || String(err));
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
				Не удалось загрузить картинку: {error}
			</p>
		);
	}
	if (!url) {
		return (
			<p class="cluster" style={{ alignItems: "center", color: "var(--muted)" }}>
				<span class="spinner" aria-hidden="true" /> Загрузка картинки…
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
	const [url, setUrl] = useState(() => (attachment.voiceInline ? null : (getMemoryCachedUrl(attachment.sha256) ?? null)));
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
		const memUrl = getMemoryCachedUrl(attachment.sha256);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadAttachment(currentUser.value.id, dbKeySig.value, attachment)
			.then((bytes) => {
				if (cancelled) return;
				setUrl(putMemoryCachedAttachment(attachment.sha256, bytes, attachment.mime));
			})
			.catch((err) => {
				if (!cancelled) setError(err?.message || String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [attachment]);

	if (error) {
		return (
			<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
				Не удалось загрузить аудио: {error}
			</p>
		);
	}
	if (!url) {
		return (
			<p class="cluster" style={{ alignItems: "center", color: "var(--muted)" }}>
				<span class="spinner" aria-hidden="true" /> Загрузка{attachment.voice ? " голосового" : " аудио"}…
			</p>
		);
	}
	return <audio controls src={url} />;
}

// Видео — ЛЕНИВАЯ загрузка по клику (до 50 МБ, этап 29-довесок; автозагрузка каждого
// видео в истории чата была бы избыточной — в отличие от картинок, ожидаемых видимыми
// сразу).
function VideoAttachment({ attachment }) {
	// Если это видео уже смотрели в этой вкладке — url есть сразу из памяти,
	// клик "Воспроизвести" не нужен повторно (тот же приём, что ImageAttachment).
	const [url, setUrl] = useState(() => getMemoryCachedUrl(attachment.sha256) ?? null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	function handleLoad() {
		setLoading(true);
		setError("");
		getOrDownloadAttachment(currentUser.value.id, dbKeySig.value, attachment)
			.then((bytes) => {
				setUrl(putMemoryCachedAttachment(attachment.sha256, bytes, attachment.mime));
			})
			.catch((err) => setError(err?.message || String(err)))
			.finally(() => setLoading(false));
	}
	// URL НЕ отзывается на unmount — им владеет attachment-memory-cache.js (см. ImageAttachment).

	if (url) {
		return <video controls autoPlay src={url} style={{ maxWidth: "100%", borderRadius: "var(--radius)", display: "block" }} />;
	}

	return (
		<p class="cluster" style={{ alignItems: "center" }}>
			<span aria-hidden="true">{FILE_TYPE_ICONS.video}</span>
			<span>
				{attachment.name} ({formatFileSize(attachment.size)})
			</span>
			<button type="button" onClick={handleLoad} disabled={loading} class="cluster" style={{ alignItems: "center" }}>
				{loading && <span class="spinner" aria-hidden="true" />}
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
			const bytes = await getOrDownloadAttachment(currentUser.value.id, dbKeySig.value, attachment);
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
			<button type="button" onClick={handleDownload} disabled={loading} class="cluster" style={{ alignItems: "center" }}>
				{loading && <span class="spinner" aria-hidden="true" />}
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
