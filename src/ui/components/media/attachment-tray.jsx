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

function TrayItem({ item, onRemove, onPositionChange }) {
	const instanceId = useId();
	const canPreviewImage = item.type === "image" && !!item.file;
	const objectUrl = useMemo(() => (canPreviewImage ? URL.createObjectURL(item.file) : null), [item.file, canPreviewImage]);

	useEffect(() => {
		return () => {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [objectUrl]);

	return (
		<div
			class="row box"
			style={{ "--gap": "var(--space-s)", "--pad": "var(--space-2xs)", "--align": "center", border: "var(--border-width) solid var(--border)", borderRadius: "var(--radius)" }}
		>
			{canPreviewImage ? (
				<img src={objectUrl} alt="" style={{ maxWidth: "6rem", maxHeight: "6rem", borderRadius: "var(--radius)" }} />
			) : (
				<span style={{ fontSize: "2rem" }} aria-hidden="true">
					{FILE_TYPE_ICONS[item.type]}
				</span>
			)}
			<span class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<span>{item.name}</span>
				<small style={{ color: "var(--muted)" }}>{formatFileSize(item.size)}</small>
				{item.error && (
					<small role="alert" style={{ color: "var(--bad)" }}>
						{item.error}
					</small>
				)}
			</span>
			{item.type === "image" && (
				<fieldset class="row" style={{ "--gap": "var(--space-s)", border: "none", padding: 0, "--align": "center" }}>
					<legend class="visually-hidden">Положение картинки относительно текста</legend>
					<span class="row" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
						<input
							id={`${instanceId}-above`}
							type="radio"
							name={`${instanceId}-position`}
							checked={item.position === "above"}
							onChange={() => onPositionChange(item.id, "above")}
						/>
						<label for={`${instanceId}-above`}>Над сообщением</label>
					</span>
					<span class="row" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
						<input
							id={`${instanceId}-below`}
							type="radio"
							name={`${instanceId}-position`}
							checked={item.position === "below"}
							onChange={() => onPositionChange(item.id, "below")}
						/>
						<label for={`${instanceId}-below`}>Под сообщением</label>
					</span>
				</fieldset>
			)}
			<button type="button" onClick={() => onRemove(item.id)}>
				Убрать
			</button>
		</div>
	);
}

export default function AttachmentTray({ items, errors, onRemove, onPositionChange }) {
	return (
		<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
			{items.map((item) => (
				<TrayItem key={item.id} item={item} onRemove={onRemove} onPositionChange={onPositionChange} />
		 ))}
			{errors.length > 0 && (
				<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					{errors.map((message, i) => (
						<small key={i} role="alert" style={{ color: "var(--bad)" }}>
							{message}
						</small>
				 ))}
				</div>
			)}
		</div>
	);
}
