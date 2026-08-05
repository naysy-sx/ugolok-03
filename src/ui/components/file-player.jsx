import { useEffect, useState } from "preact/hooks";
import { getManifest, getRange } from "../../domain/files/content.js";
import { getCachedManifest, putCachedManifest } from "../../domain/files/store.js";
import { registerPlayerFile, unregisterPlayerFile } from "../../domain/files/player-bridge.js";
import { getFileKeyFor } from "../signals/files.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { t, errorMessage } from "../signals/i18n.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Плеер (этап 53 И4, задача 4.4) — модалка по прецеденту image-modal.jsx
// (этап 29: "модалка + кнопка закрыть", без lightbox-библиотеки). <video>/
// <audio> нативные (тот же приём, что attachment-view.jsx) — src указывает
// на СВОЙ same-origin virtual-путь, перехватываемый service worker'ом
// (CONTRACTS.md/DESIGN.md), не на blob-URL: браузер сам шлёт Range по мере
// перемотки, полный файл никогда не грузится разом.
export default function FilePlayer({ digest, ownerPubkey, onClose }) {
	const [manifest, setManifest] = useState(null);
	const [imageUrl, setImageUrl] = useState(null);
	const [error, setError] = useState("");

	useEffect(() => {
		function handleKeyDown(e) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	useEffect(() => {
		let cancelled = false;
		let objectUrl = null;

		(async () => {
			try {
				let m = await getCachedManifest(ownerPubkey, digest);
				if (!m) {
					m = await getManifest(digest, { serverUrl: BLOSSOM_URL });
					await putCachedManifest(ownerPubkey, digest, m);
				}
				const fileKey = await getFileKeyFor(digest);
				if (cancelled) return;
				if (!fileKey) {
					setError(t("chat.window.fileKeyNotFoundError"));
					return;
				}
				if (m.mime?.startsWith("image/")) {
					// Картинки — НЕ через SW virtual-путь (тот приём — для video/audio,
					// где перемотка требует Range по мере воспроизведения): изображение
					// целиком мало (та же логика, что thumbnails.js — "изображения малы,
					// getRange(0, size) целиком — оправдано"), полный getRange в память +
					// Blob URL — тот же приём, что миниатюры, но без downscale (полное
					// качество, не 200px).
					const bytes = await getRange(m, fileKey, 0, m.size, { serverUrl: BLOSSOM_URL });
					if (cancelled) return;
					objectUrl = URL.createObjectURL(new Blob([bytes], { type: m.mime }));
					setImageUrl(objectUrl);
				} else {
					// РЕГИСТРАЦИЯ ОБЯЗАНА завершиться ДО первого рендера <video>/<audio> с
					// src (CONTRACTS.md/DESIGN.md "гонка 3") — иначе первый же запрос
					// браузера придёт на ещё не зарегистрированный digest.
					registerPlayerFile(digest, { manifest: m, fileKey, serverUrl: BLOSSOM_URL });
				}
				setManifest(m);
			} catch (e) {
				if (!cancelled) setError(errorMessage(e));
			}
		})();

		return () => {
			cancelled = true;
			unregisterPlayerFile(digest);
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [digest, ownerPubkey]);

	const src = `/files-content/${digest}`;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={t("filePlayer.ariaLabel")}
			onClick={onClose}
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0, 0, 0, 0.85)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 1000,
				padding: "var(--space-m)",
			}}
		>
			<div onClick={(e) => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "100%" }}>
				{error && (
					<p role="alert" style={{ color: "#fff", background: "var(--bad)", padding: "var(--space-s)", borderRadius: "var(--radius)" }}>
						{error}
					</p>
				)}
				{!error && !manifest && <p style={{ color: "#fff" }}>{t("common.loading")}</p>}
				{!error && manifest && manifest.mime?.startsWith("image/") && imageUrl && (
					<img src={imageUrl} alt="" style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: "var(--radius)", display: "block" }} />
				)}
				{!error && manifest && manifest.mime?.startsWith("video/") && (
					<video controls autoplay src={src} style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: "var(--radius)", display: "block" }} />
				)}
				{!error && manifest && manifest.mime?.startsWith("audio/") && <audio controls autoplay src={src} />}
				{!error &&
					manifest &&
					!manifest.mime?.startsWith("video/") &&
					!manifest.mime?.startsWith("audio/") &&
					!manifest.mime?.startsWith("image/") && (
						<p style={{ color: "#fff" }}>{t("filePlayer.noPreview", { mime: manifest.mime || t("filePlayer.unknownType") })}</p>
					)}
			</div>
			<button
				type="button"
				onClick={onClose}
				aria-label={t("common.close")}
				style={{
					position: "fixed",
					top: "var(--space-m)",
					right: "var(--space-m)",
					fontSize: "1.5rem",
					lineHeight: 1,
					padding: "var(--space-2xs) var(--space-s)",
				}}
			>
				✕
			</button>
		</div>
	);
}
