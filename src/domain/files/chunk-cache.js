// LRU-кэш расшифрованных чанков плеера по объёму (CONTRACTS.md/DESIGN.md,
// этап 53 И4, задача 4.3). Тот же паттерн MRU через порядок вставки Map,
// что attachment-memory-cache.js (этап 43-довесок) — delete+set двигает
// запись в MRU-конец без отдельного поля lastAccessedAt. Ключ — непрозрачная
// строка (обычно `${manifestDigest}:${chunkIndex}`, строит вызывающая
// сторона) — разные файлы не должны делить кэш по совпавшему индексу чанка.
//
// MEDIA-PERF-TZ.md §5.2/§8 п.2 — budgetBytes теперь МЕНЯЕТСЯ во время жизни
// кэша (setBudget), не фиксирован на createChunkCache(...). Вытеснение
// остаётся ЕДИНЫМ глобальным LRU по факту последнего обращения (get трогает
// запись в MRU-конец независимо от того, какому файлу принадлежит ключ) —
// это уже "с учётом времени последнего доступа", как просит ТЗ; отдельный
// файл, который сейчас реально играет, естественно остаётся горячим (его
// чанки трогаются каждым readRange), а не разросшийся бюджет — то, что
// раньше давало "вытеснение по кругу" при двух открытых файлах.
export function createChunkCache(budgetBytes) {
	const cache = new Map();
	// Этап F, F3 (DESIGN.md "Этап F, F3") — закреплённые ключи исключены из
	// цикла вытеснения по объёму. Пусто по умолчанию — без единого put(...,
	// {pin:true}) поведение НЕОТЛИЧИМО от прежнего (подтверждено регрессией).
	const pinned = new Set();
	let budget = budgetBytes;

	function get(key) {
		if (!cache.has(key)) return undefined;
		const bytes = cache.get(key);
		cache.delete(key);
		cache.set(key, bytes); // touch — в MRU-конец
		return bytes;
	}

	function evictToBudget() {
		let total = 0;
		for (const entry of cache.values()) total += entry.length;
		// cache.size > 1 — единственный оставшийся элемент не вытесняет сам
		// себя, даже если он крупнее бюджета целиком (DESIGN.md: "десять
		// чанков по 8 МБ" — вырожденный случай, временный перерасход лучше,
		// чем зацикленное вытеснение до пустого кэша на каждый put).
		while (total > budget && cache.size > 1) {
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

	function put(key, bytes, { pin = false } = {}) {
		if (cache.has(key)) cache.delete(key);
		cache.set(key, bytes);
		if (pin) pinned.add(key);
		evictToBudget();
	}

	// player-bridge.js зовёт это на КАЖДЫЙ registerPlayerFile/unregisterPlayerFile
	// (§5.2 — бюджет зависит от числа СЕЙЧАС открытых файлов). Уменьшение
	// бюджета не вытесняет ничего немедленно сверх необходимого — тот же
	// evictToBudget, что и put, просто без добавления новой записи.
	function setBudget(bytes) {
		budget = bytes;
		evictToBudget();
	}

	return { get, put, setBudget, get budget() { return budget; } };
}

// MEDIA-PERF-TZ.md §5.2/§8 п.2 — было: фиксированные 2.5 МиБ НА ВСЕ
// одновременно открытые файлы разом (комментарий в коде сам признавался, что
// исходная арифметика (k+3)·C была основана на неверном предположении о
// размере чанка). Теперь — бюджет на файл, растущий с числом открытых файлов,
// с потолком (иначе один пользователь с 20 открытыми вкладками съедает всю
// память вкладки). Числа — предложение автора (MEDIA-PERF-TZ.md §8 п.2),
// не замер: 6 МиБ/файл, потолок 24 МиБ.
export const CHUNK_CACHE_BYTES_PER_FILE = 6 * 1024 * 1024;
export const CHUNK_CACHE_CEILING_BYTES = 24 * 1024 * 1024;

export function budgetFor(openCount) {
	const n = Math.max(1, openCount || 0);
	return Math.min(CHUNK_CACHE_CEILING_BYTES, n * CHUNK_CACHE_BYTES_PER_FILE);
}
