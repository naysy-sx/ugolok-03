import Dexie from "dexie";

// Обратная (свежие -> старые) постраничная выборка по ИНДЕКСУ, не offset-
// пагинация (Dexie's .offset() пропускает N записей курсором заново от
// начала на каждой странице — Θ(позиция) на страницу, Θ(n²) на полный
// проход; здесь — Θ(1) на страницу относительно позиции, диапазон границ
// двигается по факту прочитанного). SEARCH-ALGO.md §5.3, §12 ("случайно
// квадратичное"). Обе функции — единственная инфраструктура И2, которую
// пишет Claude напрямую, не воркер (DESIGN.md §SEARCH: несущая конструкция
// I-EARLY-EXIT/I-SCAN-SHOWS-ORDER, ошибка здесь — "правдоподобно неверная
// выдача", SEARCH-SPEC.md §0).

const PAGE_YIELD_DELAY_MS = 0;

function yieldToEventLoop() {
	return new Promise((resolve) => setTimeout(resolve, PAGE_YIELD_DELAY_MS));
}

// messages: первичный ключ ++seq БЕЗ ownerPubkey в индексе (И0, П-1) —
// курсор идёт по ВСЕЙ таблице устройства (все локальные аккаунты), фильтр
// по ownerScopeField — в памяти, после чтения (не после расшифровки: поле
// уже plaintext на строке). При нескольких локальных аккаунтах на одном
// устройстве это означает, что курсор ЧИТАЕТ (не расшифровывает) чужие
// строки тоже — задокументировано как открытый вопрос, PLAN.md/CONTRACTS.md
// §SEARCH, П-1.
export async function* paginateReverseByPrimaryKey(table, ownerScopeField, ownerPubkey, { signal, pageSize = 200 } = {}) {
	let upper = Dexie.maxKey;
	while (true) {
		if (signal?.aborted) return;
		const page = await table.where(":id").below(upper).reverse().limit(pageSize).toArray();
		if (page.length === 0) return;
		for (const row of page) {
			if (signal?.aborted) return;
			if (row[ownerScopeField] === ownerPubkey) yield row;
		}
		if (page.length < pageSize) return;
		upper = page[page.length - 1].seq;
		await yieldToEventLoop();
	}
}

// posts/channelMessages: составной индекс [ownerPubkey+sortField] — owner
// уже встроен в диапазон запроса, чужие строки вообще не читаются (строго
// лучше messages). Предполагает, что у каждой строки есть уникальное в
// рамках owner поле `id` (верно для posts/channelMessages, POSTS_PLAINTEXT_
// FIELDS/CHANNEL_MESSAGES_PLAINTEXT_FIELDS, table-fields.js) — используется
// только для дедупликации на границе страницы (см. ниже), не как часть
// самого индексного диапазона.
//
// Граница страницы и совпадающие значения sortField: несколько записей с
// ОДИНАКОВЫМ createdAt на границе page[pageSize-1] — обычное дело (мульти-
// устройство тикает одну секунду, синтетические фикстуры). Если оборвать
// страницу ровно на pageSize и продолжить со "строго меньше последнего
// значения", записи с ТЕМ ЖЕ значением, не попавшие в эту страницу, будут
// пропущены НАВСЕГДА (upper становится строго меньше их sortField) — тихая
// потеря результатов, ровно та ловушка, о которой предупреждает SEARCH-
// SPEC.md §0. Поэтому при полной странице делается один прицельный
// добор — все строки с граничным значением sortField, дедуп по `id`.
export async function* paginateReverseByCompoundIndex(table, indexName, ownerPubkey, sortField, { signal, pageSize = 200 } = {}) {
	let upper = Dexie.maxKey;
	while (true) {
		if (signal?.aborted) return;
		const page = await table
			.where(indexName)
			.between([ownerPubkey, Dexie.minKey], [ownerPubkey, upper], true, false)
			.reverse()
			.limit(pageSize)
			.toArray();
		if (page.length === 0) return;
		const initialLength = page.length;
		const boundaryValue = page[page.length - 1][sortField];

		if (initialLength === pageSize) {
			const tailAtBoundary = await table.where(indexName).equals([ownerPubkey, boundaryValue]).toArray();
			const alreadyHave = new Set(page.filter((r) => r[sortField] === boundaryValue).map((r) => r.id));
			for (const row of tailAtBoundary) {
				if (!alreadyHave.has(row.id)) {
					page.push(row);
					alreadyHave.add(row.id);
				}
			}
		}

		for (const row of page) {
			if (signal?.aborted) return;
			yield row;
		}

		if (initialLength < pageSize) return;
		upper = boundaryValue;
		await yieldToEventLoop();
	}
}
