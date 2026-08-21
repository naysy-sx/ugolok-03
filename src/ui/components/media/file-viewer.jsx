import { useEffect, useState } from "preact/hooks";
import { acquireMediaUrl } from "../../../domain/media/adapters/media-url.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../../config.js";
import { t, errorMessage } from "../../signals/i18n.js";
import { formatFileSize } from "../attachment-view.jsx";
import IconFileText from "../../icons/file-text.jsx";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Редизайн интерфейса, этап 3 (DESIGN.md) — 4-й "глупый вид" (VIEWS.other,
// media-overlay.jsx), для класса "other" (файлы: документы, архивы и т.п.).
// Без плеера — acquireMediaUrl для НЕ-image/* mime всегда возвращает
// {kind:"bridge", src} (media-url.js), реальные байты не текут, пока
// пользователь не кликнет "скачать".
export default function FileViewer({ mediaRef }) {
	const [src, setSrc] = useState(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		setSrc(null);
		setError("");
		acquireMediaUrl(mediaRef, { serverUrl: BLOSSOM_URL })
			.then((handle) => {
				if (!cancelled) setSrc(handle.src);
			})
			.catch((err) => {
				if (!cancelled) setError(errorMessage(err));
			});
		return () => {
			cancelled = true;
		};
	}, [mediaRef.digest]);

	if (error) {
		return (
			<p role="alert" style={{ color: "#fff" }}>
				{t("attachment.imageLoadError", { error })}
			</p>
		);
	}
	if (!src) {
		return <p style={{ color: "#fff" }}>{t("common.loading")}</p>;
	}
	return (
		<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem", color: "#fff" }}>
			<IconFileText aria-hidden="true" style={{ width: "4rem", height: "4rem" }} />
			<div style={{ textAlign: "center" }}>
				<div>{mediaRef.name}</div>
				<div style={{ opacity: 0.7, fontSize: "0.875em" }}>{formatFileSize(mediaRef.size)}</div>
			</div>
			<a href={src} download={mediaRef.name} style={{ color: "#fff", textDecoration: "underline" }}>
				{t("attachment.download")}
			</a>
		</div>
	);
}
