import { useEffect, useState } from "preact/hooks";
import { acquireMediaUrl } from "../../domain/media/adapters/media-url.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { formatFileSize } from "./attachment-view.jsx";
import { t, errorMessage } from "../signals/i18n.js";
import FileKindIcon, { fileIconModifier } from "./file-kind-icon.jsx";
import IconCross from "../icons/cross.jsx";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function typeLabel(mime) {
	if (mime === "application/pdf") return t("files.kindPdf");
	if (
		mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		mime === "application/vnd.ms-excel"
	)
		return t("files.kindSheet");
	if (
		mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		mime === "application/msword"
	)
		return t("files.kindDocument");
	return mime || t("files.kindDocument");
}

// Маленькая модалка сведений о документе (FILES-REDESIGN §3.7). Не медиа-оверлей.
export default function FileInfoDialog({ entry, mediaRef, onClose }) {
	const [src, setSrc] = useState(null);
	const [error, setError] = useState("");

	useEffect(() => {
		function onKey(e) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		if (!mediaRef) return;
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
	}, [mediaRef?.digest]);

	const name = entry?.displayName || mediaRef?.name || "";
	const mime = entry?.mime || mediaRef?.mime;
	const size = mediaRef?.size;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={t("files.fileInfoTitle")}
			onClick={onClose}
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0, 0, 0, 0.5)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 1000,
				padding: "var(--space-m)",
			}}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				class="stack"
				style={{
					background: "var(--surface, canvas)",
					borderRadius: "var(--radius)",
					padding: "var(--space-m)",
					maxWidth: "24rem",
					width: "100%",
				}}
			>
				<div class="row" style={{ "--align": "center", "--gap": "var(--space-s)" }}>
					<h2 class="grow">{t("files.fileInfoTitle")}</h2>
					<button type="button" class="icon-btn" onClick={onClose} aria-label={t("files.fileInfoCloseAria")}>
						<IconCross />
					</button>
				</div>
				<div class="row" style={{ "--align": "center", "--gap": "var(--space-s)" }}>
					<FileKindIcon mime={mime} class={`file-row-icon file-row-icon--${fileIconModifier(mime)}`} />
					<div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
						<div>{name}</div>
						<small class="file-row-status">
							{typeLabel(mime)}
							{size != null ? ` · ${formatFileSize(size)}` : ""}
						</small>
					</div>
				</div>
				{error && (
					<p role="alert" style={{ color: "var(--bad)" }}>
						{error}
					</p>
				)}
				{src ? (
					<a href={src} download={name}>
						{t("attachment.download")}
					</a>
				) : (
					!error && <p>{t("common.loading")}</p>
				)}
			</div>
		</div>
	);
}
