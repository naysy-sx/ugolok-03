import { useEffect, useRef, useState } from "preact/hooks";
import { acquireMediaUrl, mediaElementSrc } from "../../../domain/media/adapters/media-url.js";
import { mediaErrorReasonKey, isTransientMediaError } from "../../../domain/media/media-error.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../../config.js";
import { t, errorMessage } from "../../signals/i18n.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Аудио внутри медиа-сессии (Этап D) — тот же приём/те же гарантии, что
// video-player.jsx (см. комментарий там: src через мост SW, двунаправленная
// синхронизация playing<->нативные controls без зацикливания; довесок —
// <audio> остаётся смонтированным при смене mediaRef, отказ play() от
// политики автовоспроизведения синхронизирует mediaSession, не молчит).
// elRef — см. video-player.jsx: тот же необязательный внешний ref на DOM-элемент.
export default function AudioPlayer({ mediaRef, playing, onToggle, onEnded, compact, onMeta, onTimeUpdate, elRef }) {
	const audioRef = useRef(null);
	const [src, setSrc] = useState(null);
	const [error, setError] = useState("");
	// MEDIA-PERF-TZ.md §6.3 — см. video-player.jsx: percent !== null только на
	// фолбэке без SW-controller (полное скачивание файла).
	const [percent, setPercent] = useState(null);
	const networkErrorTimer = useRef(null);
	const suppressPauseToggleRef = useRef(false);

	function clearNetworkErrorTimer() {
		if (networkErrorTimer.current) {
			clearTimeout(networkErrorTimer.current);
			networkErrorTimer.current = null;
		}
	}

	useEffect(() => {
		let cancelled = false;
		suppressPauseToggleRef.current = true;
		setSrc(null);
		setError("");
		setPercent(null);
		acquireMediaUrl(mediaRef, {
			serverUrl: BLOSSOM_URL,
			onProgress: (p) => {
				if (!cancelled && p && typeof p === "object" && p.phase === "preparing") setPercent(p.percent);
			},
		})
			.then((handle) => {
				if (!cancelled) setSrc(mediaElementSrc(handle));
			})
			.catch((err) => {
				if (!cancelled) setError(errorMessage(err));
			});
		return () => {
			cancelled = true;
			clearNetworkErrorTimer();
		};
	}, [mediaRef.digest]);

	useEffect(() => {
		const el = audioRef.current;
		if (!el || !src) return;
		if (playing) {
			el.play()
				.then(() => {
					suppressPauseToggleRef.current = false;
				})
				.catch(() => {
					suppressPauseToggleRef.current = false;
				});
		} else {
			el.pause();
			suppressPauseToggleRef.current = false;
		}
	}, [playing, src]);

	return (
		<div>
			{error && !compact && (
				<p role="alert" style={{ color: "#fff" }}>
					{t("attachment.audioLoadError", { error })}
				</p>
			)}
			{!error && !src && !compact && (
				<p style={{ color: "#fff" }}>{percent != null ? t("attachment.statusDownloading", { percent }) : t("common.loading")}</p>
			)}
			<div class="audio-shell" style={{ display: compact || !src ? "none" : undefined }}>
					<audio
						ref={(node) => {
							audioRef.current = node;
							if (elRef) elRef.current = node;
						}}
						controls={!compact}
						src={src ?? undefined}
						onEnded={onEnded}
						// см. video-player.jsx — элемент не размонтируется на error,
						// Chrome может докачать Range сам.
						onError={(e) => {
							const code = e.currentTarget.error?.code;
							const reasonKey = mediaErrorReasonKey(code);
							if (!reasonKey) return;
							if (isTransientMediaError(code)) {
								if (!networkErrorTimer.current) {
									networkErrorTimer.current = setTimeout(() => {
										setError(t(reasonKey));
										networkErrorTimer.current = null;
									}, 12_000);
								}
								return;
							}
							clearNetworkErrorTimer();
							setError(t(reasonKey));
						}}
						onCanPlay={() => {
							clearNetworkErrorTimer();
							setError("");
							const el = audioRef.current;
							if (playing && el?.paused) el.play().catch(() => {});
						}}
						onPlaying={() => {
							clearNetworkErrorTimer();
							setError("");
							suppressPauseToggleRef.current = false;
						}}
						onWaiting={() => {
							suppressPauseToggleRef.current = true;
						}}
						onSeeking={() => {
							suppressPauseToggleRef.current = true;
						}}
						onSeeked={() => {
							suppressPauseToggleRef.current = false;
							const el = audioRef.current;
							if (playing && el?.paused) el.play().catch(() => {});
						}}
						onLoadedMetadata={(e) => {
							onMeta?.({ duration: e.currentTarget.duration });
						}}
						onTimeUpdate={onTimeUpdate ? (e) => onTimeUpdate(e.currentTarget.currentTime) : undefined}
						onPlay={() => {
							if (!playing) onToggle();
						}}
						onPause={() => {
							const el = audioRef.current;
							if (suppressPauseToggleRef.current) return;
							if (!playing || !el || el.ended) return;
							if (el.seeking) return;
							if (el.networkState === 2) return;
							if (!el.getAttribute("src")) return;
							if (playing && !el.ended) onToggle();
						}}
						// compact (свёрнутый вид) — звук продолжает играть, нативные controls
						// скрыты (у mini-бара свои кнопки); display:none НЕ останавливает
						// воспроизведение аудио в фоне (в отличие от video, где точно так же
						// не останавливает — там просто нет смысла скрывать, есть картинка).
						style={{ display: compact ? "none" : src ? undefined : "none" }}
					/>
				</div>
		</div>
	);
}
