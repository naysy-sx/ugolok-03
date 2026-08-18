// MEDIA-OVERLAY-UI.md, этап 3.3 — геометрия точки открытия для анимации
// "разлёт из миниатюры". openMedia() (signals/media.js) не может получить
// новый параметр (И-0 медиа-подсистемы: сигнатура автомата не меняется) —
// вместо этого вызывающая сторона кладёт сюда getBoundingClientRect()
// кликнутого элемента ПЕРЕД вызовом openMedia; media-overlay.jsx читает
// его один раз при появлении новой сессии (переход null -> not null) и
// обнуляет — переиспользование между сессиями недопустимо, иначе next/prev
// внутри уже открытого просмотрщика подхватили бы чужую геометрию.
let originRect = null;

export function setMediaOrigin(rect) {
	originRect = rect;
}

export function consumeMediaOrigin() {
	const rect = originRect;
	originRect = null;
	return rect;
}
