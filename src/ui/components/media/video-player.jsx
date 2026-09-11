import { useEffect, useRef, useState } from "preact/hooks";
import { acquireMediaUrl, mediaElementSrc } from "../../../domain/media/adapters/media-url.js";
import { mediaErrorReasonKey, isTransientMediaError } from "../../../domain/media/media-error.js";
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
// elRef — необязательный внешний ref на сам DOM-элемент (МИНИ-бар/scrub-полоса
// пишут el.currentTime напрямую, И-D: "перемотка внутри трека — свойство
// DOM-элемента, не состояния сессии"). НЕ называется "ref" — тот зарезервирован
// Preact'ом для форвардинга и не доходит до компонента как обычный проп.
export default function VideoPlayer({ mediaRef, playing, onToggle, onEnded, compact, onMeta, onTimeUpdate, elRef }) {
	const videoRef = useRef(null);
	const [src, setSrc] = useState(null);
	const [error, setError] = useState("");
	// MEDIA-PERF-TZ.md §6.3 — фолбэк без SW-controller качает файл целиком;
	// percent !== null ТОЛЬКО в этой ветке (bridge-путь onProgress не зовёт
	// вовсе — там src готов почти сразу, качает уже сам <video> по Range).
	const [percent, setPercent] = useState(null);
	const networkErrorTimer = useRef(null);
	// pause от смены src / буфера / перемотки — не пауза пользователя.
	// Иначе листание слайдов и открытие ролика сами жали «пауза».
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
		const el = videoRef.current;
		if (!el || !src) return;
		if (playing) {
			el.play()
				.then(() => {
					suppressPauseToggleRef.current = false;
				})
				.catch(() => {
					// буфер/автоплей — не пауза пользователя; canplay попробует снова
					suppressPauseToggleRef.current = false;
				});
		} else {
			el.pause();
			suppressPauseToggleRef.current = false;
		}
	}, [playing, src]);

	return (
		<div style={{ position: "relative" }}>
			{error && !compact && (
				<p role="alert" style={{ color: "#fff" }}>
					{t("attachment.videoLoadError", { error })}
				</p>
			)}
			{!error && !src && !compact && (
				<p style={{ color: "#fff" }}>{percent != null ? t("attachment.statusDownloading", { percent }) : t("common.loading")}</p>
			)}
			<video
					ref={(node) => {
						videoRef.current = node;
						if (elRef) elRef.current = node;
					}}
					controls={!compact}
					src={src ?? undefined}
					onEnded={onEnded}
					// FILES-FIX-SPEC.md §5.1/§6.1, TZ-FIX-FILES-MEDIA-STATIC.md 5.7 —
					// acquireMediaUrl резолвится ДО сети (просто регистрирует digest
					// в player-bridge.js), поэтому 504 от SW, 404, битый кодек —
					// всё, что ломается ПОЗЖЕ — раньше не долетало до React вовсе:
					// пустой прямоугольник без единого признака отказа. onError на
					// самом элементе — единственное место, где браузер сообщает об
					// этом классе сетевых/декодных ошибок.
					//
					// <video> остаётся смонтированным и при error: Chrome шлёт
					// MEDIA_ERR_NETWORK на сорвавшийся Range, потом сам
					// переспрашивает. Раньше `{!error && <video>}` снимал элемент
					// с дерева — докачка обрывалась, на экране оставалась только
					// плашка (живой лог 2026-09-10, «сетевая ошибка» при успешных
					// player-window).
					onError={(e) => {
						const code = e.currentTarget.error?.code;
						const reasonKey = mediaErrorReasonKey(code);
						if (!reasonKey) return;
						// MEDIA_ERR_NETWORK и SRC_NOT_SUPPORTED на 404 SW — Chrome
						// сам переспрашивает. Плашка на тик <1с была ложью.
						// Показываем отказ только если за 12с не было canplay.
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
						const el = videoRef.current;
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
						const el = videoRef.current;
						if (playing && el?.paused) el.play().catch(() => {});
					}}
					onLoadedMetadata={(e) => {
						onMeta?.({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight, duration: e.currentTarget.duration });
					}}
					onTimeUpdate={onTimeUpdate ? (e) => onTimeUpdate(e.currentTarget.currentTime) : undefined}
					onPlay={() => {
						if (!playing) onToggle();
					}}
					onPause={() => {
						const el = videoRef.current;
						if (suppressPauseToggleRef.current) return;
						if (!playing || !el || el.ended) return;
						if (el.seeking) return;
						if (el.networkState === 2) return; // NETWORK_LOADING — буфер, не пауза
						if (!el.getAttribute("src")) return;
						if (playing && !el.ended) onToggle();
					}}
					style={
						compact
							? { width: "100%", height: "100%", objectFit: "cover", display: src ? "block" : "none" }
							: { maxWidth: "100%", maxHeight: "80vh", borderRadius: "var(--radius)", display: src ? "block" : "none" }
					}
				/>
		</div>
	);
}
