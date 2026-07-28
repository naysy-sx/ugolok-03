// Арифметика границ чанков — чистая логика, БЕЗ I/O (CONTRACTS.md, этап 53,
// §5.3 TASK.md). Вынесено отдельно от content.js буквально по формулировке
// ТЗ: "место, где ошибка на единицу даёт битое видео и не ловится глазами".

export function planChunks(size, chunkSize) {
	if (size === 0) return { count: 0, lastChunkSize: 0 };
	const count = Math.ceil(size / chunkSize);
	const lastChunkSize = size - (count - 1) * chunkSize;
	return { count, lastChunkSize };
}

// offset/length — байтовый диапазон в ИСХОДНОМ файле (не в чанках).
// manifest — {chunkSize, count, lastChunkSize} (вывод planChunks + chunkSize,
// НЕ полный Manifest §3.6 MATH.md с массивом дайджестов — здесь нужна только
// геометрия, не содержимое).
// firstIdx/lastIdx — индексы чанков, ПОЛНОСТЬЮ покрывающих диапазон.
// skipHead — сколько байт от начала firstIdx-чанка отбросить.
// skipTail — сколько байт от конца lastIdx-чанка отбросить.
export function rangeToChunks(offset, length, manifest) {
	const { chunkSize, count, lastChunkSize } = manifest;
	const end = offset + length; // исключающая граница
	const firstIdx = Math.floor(offset / chunkSize);
	const lastIdx = Math.floor((end - 1) / chunkSize);
	const skipHead = offset - firstIdx * chunkSize;
	const lastChunkActualSize = lastIdx === count - 1 ? lastChunkSize : chunkSize;
	const lastChunkStart = lastIdx * chunkSize;
	const skipTail = lastChunkActualSize - (end - lastChunkStart);
	return { firstIdx, lastIdx, skipHead, skipTail };
}
