const SHIM_URL = new URL("./crypto-worker-node-shim.js", import.meta.url).href;

// transport.js импортирует "../../workers/crypto.worker.js?worker&inline" —
// синтаксис специфичен для vite-плагина ?worker&inline, под голым node
// не резолвится (нет default export у необработанного файла). Продакшн-код
// НЕ трогаем (device.js обязан гонять НАСТОЯЩИЙ transport.js) — вместо
// этого подменяем ТОЛЬКО этот один спецификатор на node-эквивалент
// (crypto-worker-node-shim.js) через официальный хук резолвинга ESM.
export async function resolve(specifier, context, nextResolve) {
	if (specifier.endsWith("crypto.worker.js?worker&inline")) {
		return { url: SHIM_URL, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
