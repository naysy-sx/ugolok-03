// Этап 74 — T2 (RC-3, CONTRACTS.md/DESIGN.md "Этап 74"): единственный писатель
// на пару (ownerPubkey, groupIdHex). Web Locks API даёт межвкладочную гарантию
// (в среде без него — только внутрипроцессную, L-3, задокументировано ниже).
// navigator.locks проверяется НА КАЖДОМ вызове (не кэшируется в модульной
// переменной при загрузке) — тестам нужно подменять/удалять globalThis.navigator
// между вызовами (fallback-путь иначе никогда не был бы проверяем в среде,
// где Web Locks реально есть, как в текущем Node).
const fallbackChains = new Map(); // name -> promise (хвост цепочки)

function withInProcessMutex(name, fn) {
	const previous = fallbackChains.get(name) ?? Promise.resolve();
	const next = previous.then(fn, fn);
	// Цепочка продолжается независимо от исхода fn — ошибка одного вызова не
	// должна дедлочить очередь следующих (та же причина, что в withGroupLock's
	// адверсарный тест на исключение).
	const chained = next.then(
		() => {},
		() => {},
	);
	fallbackChains.set(name, chained);
	return next;
}

export function withGroupLock(ownerPubkey, groupIdHex, fn) {
	const name = `mls:${ownerPubkey}:${groupIdHex}`;
	if (globalThis.navigator?.locks?.request) {
		return globalThis.navigator.locks.request(name, fn);
	}
	return withInProcessMutex(name, fn);
}
