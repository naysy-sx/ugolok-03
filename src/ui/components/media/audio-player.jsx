import { useEffect, useRef, useState } from "preact/hooks";
import { acquireMediaUrl } from "../../../domain/media/adapters/media-url.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../../config.js";
import { t, errorMessage } from "../../signals/i18n.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Аудио внутри медиа-сессии (Этап D) — тот же приём/те же гарантии, что
// video-player.jsx (см. комментарий там: src через мост SW, двунаправленная
// синхронизация playing<->нативные controls без зацикливания).
export default function AudioPlayer({ mediaRef, playing, onToggle, onEnded }) {
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
		if (playing) el.play().catch(() => {});
		else el.pause();
	}, [playing, src]);

	if (error) {
		return (
			<p role="alert" style={{ color: "#fff" }}>
				{t("attachment.audioLoadError", { error })}
			</p>
		);
	}
	if (!src) {
		return <p style={{ color: "#fff" }}>{t("common.loading")}</p>;
	}
	return (
		<audio
			ref={audioRef}
			controls
			src={src}
			onEnded={onEnded}
			onPlay={() => {
				if (!playing) onToggle();
			}}
			onPause={() => {
				if (playing) onToggle();
			}}
		/>
	);
}
