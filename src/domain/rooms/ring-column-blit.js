// Rooms, этап 5 — кольцевой буфер столбцов спектрограммы. ROOMS-ALGO §7.2 [Э].
// Контракт и design-записка: PROCESS-DOCS/CONTRACTS.md/DESIGN.md "Rooms — Этап 5".
//
// buffer[writeIndex] в любой момент — САМЫЙ СТАРЫЙ столбец в кольце (следующий
// на перезапись). Порядок за кадр: записать новый столбец в buffer[writeIndex] ->
// writeIndex = nextWriteIndex(writeIndex, width) -> отрисовать по регионам
// computeBlitRegions С НОВЫМ writeIndex. Отрисовка до продвижения индекса даёт
// только что записанный столбец не на правом (новом) крае, а на месте старого.
export function computeBlitRegions(writeIndex, width) {
	const tailWidth = width - writeIndex;
	const regions = [];
	if (tailWidth > 0) regions.push({ srcX: writeIndex, width: tailWidth, destX: 0 });
	if (writeIndex > 0) regions.push({ srcX: 0, width: writeIndex, destX: tailWidth });
	return regions;
}

export function nextWriteIndex(writeIndex, width) {
	return (writeIndex + 1) % width;
}
