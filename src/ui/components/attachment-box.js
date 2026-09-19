// MEDIA-PERF-TZ-6.md §8.1. Место под картинку по width/height вложения (§3,
// attachments.js) — чтобы плитка не прыгала между «загружается» и «загрузилась».
// Чистая функция: тестируется node --test, компоненты — нет.
//
// Вложения без width/height (сообщения до §3) → undefined, поведение прежнее.
// Среднее соотношение НЕ подставляется: угаданный размер прыгает так же, как
// неугаданный.
const MAX_BOX_WIDTH_PX = 1024; // как потолок растра превью, шире картинка не бывает
const MAX_BOX_HEIGHT = "32rem"; // защита от очень «высоких» кадров

export function reservedBoxStyle(attachment) {
	const w = attachment?.width;
	const h = attachment?.height;
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
	return {
		aspectRatio: `${w} / ${h}`,
		width: "100%",
		maxWidth: `min(100%, ${Math.min(Math.round(w), MAX_BOX_WIDTH_PX)}px)`,
		maxHeight: MAX_BOX_HEIGHT,
		background: "var(--surface)",
		borderRadius: "var(--radius)",
		overflow: "hidden",
		justifyContent: "center",
	};
}
