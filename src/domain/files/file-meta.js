// Подписи в строке/плитке «Файлы»: расширение из имени (как в макете M4A/PDF),
// размер — отдельно, когда есть манифест. Не выводить длительность — её нет в узле.

export function fileExtLabel(name) {
	if (!name || typeof name !== "string") return "";
	const i = name.lastIndexOf(".");
	if (i <= 0 || i === name.length - 1) return "";
	return name.slice(i + 1).toUpperCase();
}

export function joinMeta(parts) {
	return (parts ?? []).filter(Boolean).join(" · ");
}

export function liveChildCount(childrenMap, id) {
	if (!childrenMap || typeof childrenMap.get !== "function") return 0;
	return childrenMap.get(id)?.length ?? 0;
}
