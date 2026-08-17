// LRU-кэш расшифрованных чанков плеера по объёму (CONTRACTS.md/DESIGN.md,
// этап 53 И4, задача 4.3). Тот же паттерн MRU через порядок вставки Map,
// что attachment-memory-cache.js (этап 43-довесок) — delete+set двигает
// запись в MRU-конец без отдельного поля lastAccessedAt. Ключ — непрозрачная
// строка (обычно `${manifestDigest}:${chunkIndex}`, строит вызывающая
// сторона) — разные файлы не должны делить кэш по совпавшему индексу чанка.
export function createChunkCache(budgetBytes) {
	const cache = new Map();
	// Этап F, F3 (DESIGN.md "Этап F, F3") — закреплённые ключи исключены из
	// цикла вытеснения по объёму. Пусто по умолчанию — без единого put(...,
	// {pin:true}) поведение НЕОТЛИЧИМО от прежнего (подтверждено регрессией).
	const pinned = new Set();

	function get(key) {
		if (!cache.has(key)) return undefined;
		const bytes = cache.get(key);
		cache.delete(key);
		cache.set(key, bytes); // touch — в MRU-конец
		return bytes;
	}

	function put(key, bytes, { pin = false } = {}) {
		if (cache.has(key)) cache.delete(key);
		cache.set(key, bytes);
		if (pin) pinned.add(key);
		let total = 0;
		for (const entry of cache.values()) total += entry.length;
		// cache.size > 1 — единственный оставшийся элемент не вытесняет сам
		// себя, даже если он крупнее бюджета целиком (DESIGN.md: "десять
		// чанков по 8 МБ" — вырожденный случай, временный перерасход лучше,
		// чем зацикленное вытеснение до пустого кэша на каждый put).
		while (total > budgetBytes && cache.size > 1) {
			let victim;
			for (const k of cache.keys()) {
				if (!pinned.has(k)) {
					victim = k;
					break;
				}
			}
			if (victim === undefined) break; // все оставшиеся записи закреплены — вытеснять нечего
			total -= cache.get(victim).length;
			cache.delete(victim);
		}
	}

	return { get, put };
}
