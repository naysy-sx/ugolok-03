// Сортировка листинга — тотальная, с разрывом связей по id (§7 TASK.md:
// "иначе список дрожит между рендерами, читается как баг синхронизации").
// Естественный порядок имён — Intl.Collator{numeric:true}, свой компаратор
// не пишем (ALGO.MD §8: "будет неверен для кириллицы").
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function extOf(name) {
	if (typeof name !== "string") return "";
	const i = name.lastIndexOf(".");
	return i <= 0 || i === name.length - 1 ? "" : name.slice(i + 1);
}

const COMPARATORS = {
	name: (a, b) => collator.compare(a.displayName, b.displayName),
	// Папки перед файлами внутри одного критерия сортировки — общий
	// файл-менеджерный обычай, не запрошено явно, но ожидаемо по умолчанию.
	kind: (a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1),
	// size — размер файла (из манифеста; вызывающий кладёт его в entry.size), blob.size — прежняя форма записей.
	size: (a, b) => (a.size ?? a.blob?.size ?? 0) - (b.size ?? b.blob?.size ?? 0),
	// type — расширение из имени (без манифеста): «jpg» < «pdf»; без расширения — в начале.
	type: (a, b) => collator.compare(extOf(a.displayName), extOf(b.displayName)),
};

// entries: [{id, displayName, kind, blob, ...}] — узлы ОДНОЙ папки (уже
// отфильтрованные вызывающей стороной, project().children даёт список id,
// сюда передаются уже разыменованные записи).
export function sortEntries(entries, sortKey = "name", direction = "asc") {
	const cmp = COMPARATORS[sortKey] ?? COMPARATORS.name;
	const sign = direction === "desc" ? -1 : 1;
	return entries.slice().sort((a, b) => {
		if (sortKey !== "kind") {
			const kindCmp = COMPARATORS.kind(a, b);
			if (kindCmp !== 0) return kindCmp; // папки всегда впереди, вне зависимости от критерия
		}
		const primary = cmp(a, b);
		if (primary !== 0) return sign * primary;
		// Разрыв связей по id — ТОТАЛЬНЫЙ порядок, не зависит от direction
		// (иначе при "desc" одинаковые по критерию записи менялись бы местами
		// от рендера к рендеру так же, как без разрыва связей вовсе).
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}
