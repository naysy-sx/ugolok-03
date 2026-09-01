import { signal } from "@preact/signals";

// Состояние экрана результатов поиска. Форма — SEARCH-UI-TASK.md §3.1,
// уточняет SEARCH-SPEC.md §3.6: `groups` здесь УПОРЯДОЧЕННЫЙ массив (не
// объект-карта по type) — порядок показа групп важен для UI (перемычка,
// сквозная навигация стрелками), явный массив избавляет от отдельного
// "порядка ключей" рядом с самими данными. `parts` и `currentSource`
// добавлены сверх исходного контракта — нужны отрисовке (фишки запроса,
// подсветка, полоса хода поиска), которых не было в абстрактной модели
// SEARCH-SPEC.md.
//
// query — зафиксированный по Enter запрос, НЕ то, что живёт в поле
// сайдбара (то — локальный useState в nav-groups.jsx). Смешение этих двух
// значений — самая вероятная ошибка этого экрана (SEARCH-SPEC.md §3.6).
export const searchState = signal({
	runId: 0,
	query: "",
	parts: [],
	status: "idle", // "idle" | "running" | "done" | "cancelled"
	currentSource: null,
	groups: [], // [{ type, hits, exhausted, running }], НЕ обязательно в порядке показа — см. DISPLAY_ORDER
});

// Порядок ПОКАЗА групп (SEARCH-SPEC.md §5: "контакты, каналы, сообщения,
// посты, комментарии, сообщения каналов") — НЕ совпадает с порядком ОБХОДА
// источников движком (engine.js's SOURCES_IN_ORDER: контакты, каналы,
// комментарии, посты, сообщения каналов, сообщения — §3.3, дешёвые первыми
// ради задержки). Группы прилетают в searchState.groups в порядке прихода
// (порядке обхода), а рендерится/обходится клавиатурой — всегда в этом
// порядке. Раздельные константы — потому что настоящее совпадение было бы
// случайностью, а не гарантией контракта.
export const DISPLAY_ORDER = ["contact", "channel", "message", "post", "comment", "channelMessage"];

export function sortByDisplayOrder(groups) {
	return [...groups].sort((a, b) => DISPLAY_ORDER.indexOf(a.type) - DISPLAY_ORDER.indexOf(b.type));
}
