import { useEffect, useMemo } from "preact/hooks";
import { t } from "../../signals/i18n.js";
import FileKindIcon from "../file-kind-icon.jsx";
import IconCross from "../../icons/cross.jsx";
import IconPlayerPlay from "../../icons/player-play.jsx";
import { videoPosterStyle, videoPosterUrl } from "../video-poster-style.js";

const LAYOUT_CHIPS = [
	["duo", "attachment.layoutDuo"],
	["trio", "attachment.layoutTrio"],
	["quad", "attachment.layoutQuad"],
	["hero", "attachment.layoutHero"],
	["stack", "attachment.layoutStack"],
];

function fileExt(name) {
	const m = /\.([a-zA-Z0-9]{1,4})$/.exec(name || "");
	return m ? m[1].toUpperCase() : "";
}

function visualCount(items) {
	return items.filter((item) => item.type === "image" || item.type === "video").length;
}

function TrayThumb({ item, onRemove }) {
	const canPreviewImage = item.type === "image" && !!item.file;
	const objectUrl = useMemo(() => (canPreviewImage ? URL.createObjectURL(item.file) : null), [item.file, canPreviewImage]);

	useEffect(() => {
		return () => {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [objectUrl]);

	const poster = item.type === "video" ? videoPosterUrl(item.poster) : null;
	const thumbStyle = videoPosterStyle(poster);

	return (
		<div class={`attach-tray-thumb${item.type === "file" || item.type === "audio" ? " attach-tray-thumb--file" : ""}`} style={thumbStyle}>
			{canPreviewImage && <img src={objectUrl} alt="" />}
			{item.type === "image" && !canPreviewImage && (
				<span class="attach-tray-thumb-file">
					<FileKindIcon mime={item.mime} />
				</span>
			)}
			{item.type === "video" && !poster && (
				<span class="attach-tray-thumb-play" aria-hidden="true">
					<IconPlayerPlay />
				</span>
			)}
			{(item.type === "file" || item.type === "audio") && (
				<span class="attach-tray-thumb-file">
					<FileKindIcon mime={item.mime} />
					<span>{fileExt(item.name)}</span>
				</span>
			)}
			<button type="button" class="attach-tray-thumb-remove" onClick={() => onRemove(item.id)} aria-label={t("common.delete")}>
				<IconCross />
			</button>
			{item.error && (
				<small class="attach-tray-thumb-error" role="alert">
					{item.error}
				</small>
			)}
		</div>
	);
}

export default function AttachmentTray({ items, errors, onRemove, layout = null, onLayoutChange }) {
	const setLayout = onLayoutChange || (() => {});
	const visuals = visualCount(items);

	return (
		<div class="attach-tray stack" style={{ "--gap": "var(--space-2xs)" }}>
			{items.length > 0 && (
				<div class="attach-tray-film">
					{items.map((item) => (
						<TrayThumb key={item.id} item={item} onRemove={onRemove} />
					))}
				</div>
			)}
			{visuals >= 2 && (
				<fieldset class="attach-layouts">
					<legend class="visually-hidden">{t("attachment.layoutGroup")}</legend>
					{LAYOUT_CHIPS.map(([id, key]) => (
						<button type="button" key={id} class={layout === id ? "is-on" : undefined} onClick={() => setLayout(id)}>
							{t(key)}
						</button>
					))}
				</fieldset>
			)}
			{visuals >= 2 && <p class="attach-layout-hint">{t("attachment.layoutHint")}</p>}
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
