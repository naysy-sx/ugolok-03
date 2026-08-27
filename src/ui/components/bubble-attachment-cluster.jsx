import { useEffect, useState } from "preact/hooks";
import { t } from "../signals/i18n.js";
import FileKindIcon from "./file-kind-icon.jsx";
import IconPlayerPlay from "../icons/player-play.jsx";
import { ImageAttachment, formatFileSize, AUDIO_WAVE_HEIGHTS, openWithOrigin } from "./attachment-view.jsx";
import { truncateFileName } from "./bubble-attachment-plan.js";
import { videoPosterStyle, videoPosterUrl } from "./video-poster-style.js";
import { getMemoryCachedUrl } from "../attachment-memory-cache.js";
import { extractVideoPoster } from "../media/extract-video-poster.js";

function visibleCap(layout) {
	if (layout === "single") return 1;
	if (layout === "duo") return 2;
	if (layout === "trio") return 3;
	if (layout === "quad") return 4;
	return Infinity;
}

function VideoTile({ attachment, onOpen, moreCount = 0 }) {
	const [cachedPoster, setCachedPoster] = useState(null);
	const poster = videoPosterUrl(attachment.poster) || cachedPoster;
	useEffect(() => {
		if (videoPosterUrl(attachment.poster) || cachedPoster) return;
		const memUrl = attachment.manifestDigest ? getMemoryCachedUrl(attachment.manifestDigest) : null;
		if (!memUrl) return;
		let cancelled = false;
		fetch(memUrl)
			.then((r) => r.blob())
			.then((blob) => extractVideoPoster(new File([blob], attachment.name || "video", { type: attachment.mime || blob.type || "video/mp4" })))
			.then((url) => {
				if (!cancelled && url) setCachedPoster(url);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [attachment.manifestDigest, attachment.poster, attachment.mime, attachment.name, cachedPoster]);
	const meta = attachment.duration ? String(attachment.duration) : formatFileSize(attachment.size);
	return (
		<button
			type="button"
			class={`bubble-tile bubble-tile--video${poster ? " has-poster" : ""}`}
			style={videoPosterStyle(poster)}
			onClick={(e) => openWithOrigin(e, attachment, onOpen)}
			aria-label={t("attachment.openVideoAria", { name: truncateFileName(attachment.name) })}
		>
			<span class="bubble-tile-play" aria-hidden="true">
				<IconPlayerPlay />
			</span>
			<span class="bubble-tile-vmeta">
				<span>{t("attachment.videoBadge")}</span>
				<span>{meta}</span>
			</span>
			{moreCount > 0 && (
				<span class="bubble-tile-more" aria-hidden="true">
					{t("attachment.moreCount", { count: moreCount })}
				</span>
			)}
		</button>
	);
}

function ImageTile({ attachment, onOpen, moreCount = 0 }) {
	return (
		<div class="bubble-tile bubble-tile--image">
			<ImageAttachment attachment={attachment} onOpen={onOpen} />
			{moreCount > 0 && (
				<span class="bubble-tile-more" aria-hidden="true">
					{t("attachment.moreCount", { count: moreCount })}
				</span>
			)}
		</div>
	);
}

function Tile({ attachment, onOpen, moreCount = 0 }) {
	if (attachment.type === "video") return <VideoTile attachment={attachment} onOpen={onOpen} moreCount={moreCount} />;
	return <ImageTile attachment={attachment} onOpen={onOpen} moreCount={moreCount} />;
}

function MediaCluster({ layout, visual, onOpen }) {
	if (!visual.length) return null;
	const usedLayout = layout || "single";

	if (usedLayout === "hero") {
		const rest = visual.slice(1, 5);
		const overflow = Math.max(0, visual.length - 1 - rest.length);
		return (
			<div class="bubble-media bubble-media--hero">
				<Tile attachment={visual[0]} onOpen={onOpen} />
				{rest.length > 0 && (
					<div class="bubble-media-strip">
						{rest.map((a, i) => (
							<Tile key={i} attachment={a} onOpen={onOpen} moreCount={i === rest.length - 1 ? overflow : 0} />
						))}
					</div>
				)}
			</div>
		);
	}

	if (usedLayout === "stack") {
		return (
			<div class="bubble-media bubble-media--stack">
				{visual.map((a, i) => (
					<Tile key={i} attachment={a} onOpen={onOpen} />
				))}
			</div>
		);
	}

	const cap = visibleCap(usedLayout);
	const shown = Number.isFinite(cap) ? visual.slice(0, cap) : visual;
	const overflow = Math.max(0, visual.length - shown.length);
	return (
		<div class={`bubble-media bubble-media--${usedLayout}`}>
			{shown.map((a, i) => (
				<Tile key={i} attachment={a} onOpen={onOpen} moreCount={i === shown.length - 1 ? overflow : 0} />
			))}
		</div>
	);
}

function FileChip({ attachment, onOpen }) {
	return (
		<button
			type="button"
			class="bubble-filechip"
			onClick={(e) => onOpen && openWithOrigin(e, attachment, onOpen)}
			aria-label={t("attachment.openAria", { name: truncateFileName(attachment.name) })}
		>
			<span class="bubble-filechip-ico">
				<FileKindIcon mime={attachment.mime} />
			</span>
			<span class="bubble-filechip-text">
				<b>{attachment.name}</b>
				<small>{formatFileSize(attachment.size)}</small>
			</span>
		</button>
	);
}

function AudioChip({ attachment, onOpen }) {
	return (
		<button
			type="button"
			class="bubble-audiochip"
			onClick={(e) => onOpen && openWithOrigin(e, attachment, onOpen)}
			aria-label={t("attachment.openAudioAria", { name: truncateFileName(attachment.name) })}
		>
			<span class="bubble-filechip-ico">
				<FileKindIcon mime={attachment.mime} />
			</span>
			<span class="wave" aria-hidden="true">
				{AUDIO_WAVE_HEIGHTS.map((h, i) => (
					<i key={i} style={{ height: `${h}px` }} />
				))}
			</span>
			<small>{formatFileSize(attachment.size)}</small>
		</button>
	);
}

export function BubbleFileChips({ plan, onOpen }) {
	if (!plan || (plan.files.length === 0 && plan.audios.length === 0)) return null;
	return (
		<div class="bubble-chips">
			{plan.files.map((a, i) => (
				<FileChip key={`f-${i}`} attachment={a} onOpen={onOpen} />
			))}
			{plan.audios.map((a, i) => (
				<AudioChip key={`a-${i}`} attachment={a} onOpen={onOpen} />
			))}
		</div>
	);
}

export default function BubbleAttachmentCluster({ plan, onOpen }) {
	if (!plan || plan.visual.length === 0) return null;
	return <MediaCluster layout={plan.layout} visual={plan.visual} onOpen={onOpen} />;
}
