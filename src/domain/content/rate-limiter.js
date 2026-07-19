// DESIGN.md, этап 33, формализация 3 — не автомат, монотонный guard. "Живёт как
// актор" (ТЗ пользователя, star-topology-мир с явными акторами) — здесь просто
// объект с closure-состоянием, созданный/выброшенный вместе с жизненным циклом
// компонента канала (useState(() => createRateLimiter()) в ChannelDetail).
export function createRateLimiter(windowMs = 5000) {
	const lastActionAt = new Map();
	return {
		tryAction(actionType, now = Date.now()) {
			const last = lastActionAt.get(actionType);
			if (last !== undefined && now - last < windowMs) return false;
			lastActionAt.set(actionType, now);
			return true;
		},
	};
}
