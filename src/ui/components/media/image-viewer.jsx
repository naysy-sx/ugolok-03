import { useEffect, useState } from "preact/hooks";
import { acquireMediaUrl } from "../../../domain/media/adapters/media-url.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../../config.js";
import { t, errorMessage } from "../../signals/i18n.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Просмотрщик картинки внутри медиа-сессии (Этап D) — без zoom/swipe, тот
// же отказ, что уже был у ImageModal (CONTRACTS.md, этап 29: "модалка +
// кнопка закрыть", без lightbox-библиотеки). Next/prev/закрытие/сворачивание
// — общий chrome в media-overlay.jsx, этот компонент — только сама картинка.
// acquireMediaUrl — та же мемоизированная функция, что уже вызвал
// resourceOwner (ui/signals/media.js) — повторный вызов здесь НЕ повторяет
// сеть/регистрацию, просто дожидается готового handle (CONTRACTS.md "Этап D").
export default function ImageViewer({ mediaRef, onMeta }) {
	const [url, setUrl] = useState(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		setUrl(null);
		setError("");
		acquireMediaUrl(mediaRef, { serverUrl: BLOSSOM_URL })
			.then((handle) => {
				if (!cancelled) setUrl(handle.url);
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
	if (!url) {
		return <p style={{ color: "#fff" }}>{t("common.loading")}</p>;
	}
	return (
		<img
			src={url}
			alt={mediaRef.name || ""}
			onLoad={(e) => onMeta?.({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
			style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: "var(--radius)", display: "block" }}
		/>
	);
}
