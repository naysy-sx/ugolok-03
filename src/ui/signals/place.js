import { signal } from "@preact/signals";

// Редизайн интерфейса, этап 10.1 (CONTRACTS.md/DESIGN.md, "Состояние
// места (10.1)") — единственный источник "где я нахожусь", заменяет
// activeId (app.jsx)/activeChatPubkey (signals/chat.js)/activeChannelId+
// channelPostTarget (signals/channel-nav.js). Формализация инвариантов —
// DESIGN.md. goTo — ПОЛНАЯ замена объекта, не merge: смена kind не может
// утащить за собой чужие postId/commentId (класс бага, который раньше
// давали три независимых сигнала, отчёт A1/A3).
export const DEFAULT_PLACE = { kind: "journal" };
export const place = signal(DEFAULT_PLACE);

export function goTo(next) {
	place.value = next;
}

// id опционален (undefined = список переписок) — единственный kind, где
// отсутствие id не значит "другой экран", а значит "тот же экран, режим
// списка" (chat.jsx уже так устроен изнутри).
export function openChat(pubkey, { backTo } = {}) {
	// Куда ведёт «Назад» из открытого чата: откуда человек пришёл (например, из
	// «Контактов»), а не всегда в список чатов. Хранится отдельно от place — форма
	// place остаётся ровно такой, какую проверяют тесты и остальной код. Каждый вход
	// в чат перезаписывает значение, поэтому «Назад» не утекает из прошлого перехода.
	chatBackTo = pubkey && backTo ? backTo : null;
	place.value = pubkey ? { kind: "chat", id: pubkey } : { kind: "chat" };
}

let chatBackTo = null;

export function getChatBackTo() {
	return chatBackTo;
}

// target — {postId?, commentId?, subTab?}, атомарно ОДНИМ присваиванием
// (было — два отдельных вызова openChannel()+setChannelPostTarget(),
// отдельная функция для второго убрана: единственные два вызывающих,
// notification-nav.js и today.jsx, переходят на второй параметр).
export function openChannel(channelId, target = {}) {
	place.value = channelId
		? { kind: "channel", id: channelId, subTab: target.subTab, postId: target.postId, commentId: target.commentId }
		: { kind: "channels" };
}

// ТЗ редизайн канала A — явный вход на страницу записи. postId живёт,
// пока пользователь не вернётся в ленту (openChannel(channelId)).
//
// highlightParts — необязательные части поискового запроса (живой фидбек,
// переход из поиска): channel-post-page.jsx прокручивает к первому
// абзацу/пункту, содержащему любую из частей, и на время подсвечивает
// его целиком, а после использования сам стирает поле из place (тот же
// приём, что уже применён для commentId чуть ниже по файлу).
export function openChannelPost(channelId, postId, commentId, highlightParts) {
	// Ключ добавляется, только если реально передан — иначе место "channel"
	// без поиска получало бы лишнее highlightParts:undefined и расходилось
	// бы с точной формой, которую уже проверяют существующие тесты/код
	// (deepStrictEqual различает "ключа нет" и "ключ есть, значение undefined").
	place.value = { kind: "channel", id: channelId, postId, commentId, ...(highlightParts ? { highlightParts } : {}) };
}

// Глобальный поиск (SEARCH-SPEC.md §3.7). query — непустая строка,
// зафиксированная по Enter (вызывающий код гарантирует I-EMPTY-NOOP —
// на пустом поле openSearch не вызывается вовсе, не сюда).
//
// placeBeforeSearch — куда вернуться по closeSearch (живой фидбек:
// экран результатов не даёт очевидного способа уйти, кнопка отмены
// обязана вернуть на ТО МЕСТО, откуда искали, не жёстко в Журнал).
// Запоминается только при ВХОДЕ в поиск (kind ещё не "search") — повторный
// openSearch С ЭКРАНА РЕЗУЛЬТАТОВ (уточнение запроса) не должен
// перезаписывать точку возврата на сам экран поиска.
let placeBeforeSearch = DEFAULT_PLACE;

export function openSearch(query) {
	if (place.value.kind !== "search") placeBeforeSearch = place.value;
	place.value = { kind: "search", query };
}

export function closeSearch() {
	place.value = placeBeforeSearch;
}

// Э4.5 ТЗ-NATIVE-APPS — аппаратная кнопка «Назад» на Android, третий шаг
// цепочки (после закрытия оверлея/модалки и drawer — те решаются платформенно
// в app.jsx через уже существующий Escape-путь, DOM здесь не нужен). "Место"
// (10.1) — единственный источник "где я нахожусь", поэтому единственный
// источник и для "куда назад": детальные views (chat/channel с id, search)
// возвращают к своему списку/точке входа; верхнеуровневые "вкладки" (people,
// discovery, settings и т.д.) возвращают в DEFAULT_PLACE (journal); сам
// journal — корень, возвращать false (вызывающий код на Android сворачивает
// приложение, не завершает процесс).
export function goBackOnePlace() {
	const current = place.value;
	if (current.kind === DEFAULT_PLACE.kind) return false;
	if (current.kind === "search") {
		closeSearch();
		return true;
	}
	if (current.kind === "chat" && current.id) {
		const backTo = getChatBackTo();
		place.value = backTo ?? { kind: "chat" };
		return true;
	}
	if (current.kind === "channel" && current.id) {
		place.value = { kind: "channels" };
		return true;
	}
	place.value = DEFAULT_PLACE;
	return true;
}
