// MEDIA-PERF-TZ-6.md §8. Чистая логика выбора индикатора — вынесена из
// компонентов, чтобы тестироваться node --test (как media-error.js): сами
// компоненты в node-тестах не проверяются.
//
// Контракт onProgress везде один: объект { phase, percent }, где percent —
// целое 0..100 или null. null значит «считать нечего» (decrypting, файл из
// кэша, вложение без манифеста) — только тогда UI рисует неопределённый
// волчок. Индикатор, который врёт, хуже волчка, который ничего не обещает,
// поэтому процент выдумывать нельзя: он берётся только из фактических байтов.

// { bytesDone, bytesTotal } из content.js::getRange -> percent | null.
export function downloadPercent(progress) {
	const { bytesDone, bytesTotal } = progress ?? {};
	if (!Number.isFinite(bytesDone) || !Number.isFinite(bytesTotal) || bytesTotal <= 0) return null;
	return Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100)));
}

// Что рисовать. percent — определённая полоса/число; иначе idle: вызывающий
// сам решает, что это, — волчок (пока грузим) или ничего (уже готово).
export function pickIndicator({ percent } = {}) {
	if (Number.isFinite(percent)) return { kind: "percent", percent };
	return { kind: "idle" };
}
