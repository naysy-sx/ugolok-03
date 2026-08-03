import { useEffect, useId, useMemo } from "preact/hooks";

const FILE_TYPE_ICONS = {
	image: "🖼️",
	video: "🎞️",
	audio: "🎵",
	file: "📄",
};

function formatFileSize(bytes) {
	if (bytes < 1024) return `${bytes} Б`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

// Та же категоризация, что src/domain/attachments/upload.js (attachmentTypeFromMime) —
// дублирование сознательное: upload.js работает с уже готовым mime-параметром на
// уровне домена, здесь — с браузерным File.type на уровне UI, разные слои.
function attachmentTypeFromMime(mime) {
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("image/")) return "image";
	return "file";
}

// Превью ВЫБРАННОГО, ещё не отправленного файла (до загрузки на Blossom) — локальный
// URL.createObjectURL, без canvas-resize/отдельного thumbnail (CONTRACTS.md, этап 29 —
// сознательное сужение скоупа относительно PLAN.md/F-AT-06).
export default function AttachmentPreview({ file, position, onPositionChange, onRemove, error }) {
	const type = attachmentTypeFromMime(file.type);
	const instanceId = useId();
	const objectUrl = useMemo(() => (type === "image" ? URL.createObjectURL(file) : null), [file, type]);

	useEffect(() => {
		return () => {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [objectUrl]);

	return (
		<div
			class="row box"
			style={{ "--gap": "var(--space-s)", "--pad": "var(--space-2xs)", alignItems: "center", border: "var(--border-width) solid var(--border)", borderRadius: "var(--radius)" }}
		>
			{type === "image" ? (
				<img src={objectUrl} alt="" style={{ maxWidth: "6rem", maxHeight: "6rem", borderRadius: "var(--radius)" }} />
			) : (
				<span style={{ fontSize: "2rem" }} aria-hidden="true">
					{FILE_TYPE_ICONS[type]}
				</span>
			)}
			<span class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<span>{file.name}</span>
				<small style={{ color: "var(--muted)" }}>{formatFileSize(file.size)}</small>
				{error && (
					<small role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{error}
					</small>
				)}
			</span>
			{type === "image" && (
				<fieldset class="row" style={{ "--gap": "var(--space-s)", border: "none", padding: 0, alignItems: "center" }}>
					<legend class="visually-hidden">Положение картинки относительно текста</legend>
					<span class="row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}>
						<input
							id={`${instanceId}-above`}
							type="radio"
							name={`${instanceId}-position`}
							checked={position === "above"}
							onChange={() => onPositionChange("above")}
						/>
						<label for={`${instanceId}-above`}>Над сообщением</label>
					</span>
					<span class="row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}>
						<input
							id={`${instanceId}-below`}
							type="radio"
							name={`${instanceId}-position`}
							checked={position === "below"}
							onChange={() => onPositionChange("below")}
						/>
						<label for={`${instanceId}-below`}>Под сообщением</label>
					</span>
				</fieldset>
			)}
			<button type="button" onClick={onRemove}>
				Убрать
			</button>
		</div>
	);
}
