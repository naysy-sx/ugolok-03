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
//
// Довесок (найдено живой проверкой пользователя, Firefox/Zen) — MEDIA-SPEC.md
// R4 "next после ended не стартует... при отказе — показать кнопку, не
// молчать" был закрыт не до конца: (1) смена mediaRef на doNext/doPrev роняла
// src в null -> компонент рендерил СОВСЕМ ДРУГОЕ дерево (<p>Loading</p> вместо
// <video>) -> старый <video> размонтировался, новый монтировался заново при
// готовности src — лишний разрыв DOM-элемента ровно в тот момент, когда
// автовоспроизведению и так труднее всего устоять. Теперь <video> остаётся
// СМОНТИРОВАННЫМ всегда (src=undefined, пока не готов — Preact не пишет
// атрибут вовсе), "Loading" — оверлей поверх, не замена дерева. (2) play()
// мог отклониться политикой автовоспроизведения браузера — .catch(()=>{})
// молча проглатывал это, оставляя mediaSession.play="playing" НЕ
// соответствующим реальности (кнопка/индикатор молча врали). Теперь отказ
// синхронизирует состояние сессии через onToggle — пользователь СРАЗУ видит
// кнопку "▶", не гадает, почему тишина.
export default function VideoPlayer({ mediaRef, playing, onToggle, onEnded, compact, onMeta, onTimeUpdate }) {
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
		if (playing) {
			el.play().catch(() => {
				if (playing) onToggle();
			});
		} else {
			el.pause();
		}
	}, [playing, src]);

	return (
		<div style={{ position: "relative" }}>
			{error && !compact && (
				<p role="alert" style={{ color: "#fff" }}>
					{t("attachment.videoLoadError", { error })}
				</p>
			)}
			{!error && !src && !compact && <p style={{ color: "#fff" }}>{t("common.loading")}</p>}
			{!error && (
				<video
					ref={videoRef}
					controls={!compact}
					src={src ?? undefined}
					onEnded={onEnded}
					onLoadedMetadata={(e) => {
						onMeta?.({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight, duration: e.currentTarget.duration });
					}}
					onTimeUpdate={onTimeUpdate ? (e) => onTimeUpdate(e.currentTarget.currentTime) : undefined}
					onPlay={() => {
						if (!playing) onToggle();
					}}
					onPause={() => {
						if (playing) onToggle();
					}}
					style={
						compact
							? { width: "100%", height: "100%", objectFit: "cover", display: src ? "block" : "none" }
							: { maxWidth: "100%", maxHeight: "80vh", borderRadius: "var(--radius)", display: src ? "block" : "none" }
					}
				/>
			)}
		</div>
	);
}
