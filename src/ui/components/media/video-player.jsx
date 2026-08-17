import { useEffect, useRef, useState } from "preact/hooks";
import { acquireMediaUrl } from "../../../domain/media/adapters/media-url.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../../config.js";
import { t, errorMessage } from "../../signals/i18n.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Видео внутри медиа-сессии (Этап D) — src через мост SW (registerPlayerFile,
// уже построен и работает, player-bridge.js), браузер сам шлёт Range по мере
// перемотки, полный файл никогда не грузится разом (тот же приём, что был у
// FilePlayer). playing — управление ИЗВНЕ (mediaSession.play, в т.ч. И2 —
// звонок приостанавливает); onPlay/onPause — обратная связь, если пользователь
// щёлкнул НАТИВНЫЕ controls браузера — состояние сессии обязано узнать об
// этом (иначе mediaSession.play разойдётся с реальным состоянием DOM-элемента).
// Оба направления защищены от зацикливания: эффект ниже вызывает play()/pause()
// ТОЛЬКО когда playing реально изменился, onPlay/onPause вызывают onToggle
// ТОЛЬКО когда состояние ещё не совпадает.
export default function VideoPlayer({ mediaRef, playing, onToggle, onEnded }) {
	const videoRef = useRef(null);
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
		const el = videoRef.current;
		if (!el || !src) return;
		if (playing) el.play().catch(() => {});
		else el.pause();
	}, [playing, src]);

	if (error) {
		return (
			<p role="alert" style={{ color: "#fff" }}>
				{t("attachment.videoLoadError", { error })}
			</p>
		);
	}
	if (!src) {
		return <p style={{ color: "#fff" }}>{t("common.loading")}</p>;
	}
	return (
		<video
			ref={videoRef}
			controls
			src={src}
			onEnded={onEnded}
			onPlay={() => {
				if (!playing) onToggle();
			}}
			onPause={() => {
				if (playing) onToggle();
			}}
			style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: "var(--radius)", display: "block" }}
		/>
	);
}
