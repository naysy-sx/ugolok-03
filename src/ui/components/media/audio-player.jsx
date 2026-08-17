import { useEffect, useRef, useState } from "preact/hooks";
import { acquireMediaUrl } from "../../../domain/media/adapters/media-url.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../../config.js";
import { t, errorMessage } from "../../signals/i18n.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Аудио внутри медиа-сессии (Этап D) — тот же приём/те же гарантии, что
// video-player.jsx (см. комментарий там: src через мост SW, двунаправленная
// синхронизация playing<->нативные controls без зацикливания; довесок —
// <audio> остаётся смонтированным при смене mediaRef, отказ play() от
// политики автовоспроизведения синхронизирует mediaSession, не молчит).
export default function AudioPlayer({ mediaRef, playing, onToggle, onEnded, compact }) {
	const audioRef = useRef(null);
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

	useEffect(() => {
		const el = audioRef.current;
		if (!el || !src) return;
		if (playing) {
			el.play().catch(() => {
				if (playing) onToggle();
			});
		} else {
			el.pause();
		}
	}, [playing, src]);

	return (
		<div>
			{error && !compact && (
				<p role="alert" style={{ color: "#fff" }}>
					{t("attachment.audioLoadError", { error })}
				</p>
			)}
			{!error && !src && !compact && <p style={{ color: "#fff" }}>{t("common.loading")}</p>}
			{!error && (
				<audio
					ref={audioRef}
					controls={!compact}
					src={src ?? undefined}
					onEnded={onEnded}
					onPlay={() => {
						if (!playing) onToggle();
					}}
					onPause={() => {
						if (playing) onToggle();
					}}
					// compact (свёрнутый вид) — звук продолжает играть, нативные controls
					// скрыты (у mini-бара свои кнопки); display:none НЕ останавливает
					// воспроизведение аудио в фоне (в отличие от video, где точно так же
					// не останавливает — там просто нет смысла скрывать, есть картинка).
					style={{ display: compact ? "none" : src ? undefined : "none" }}
				/>
			)}
		</div>
	);
}
