// Журнал загрузки — кольцевой буфер В ПАМЯТИ, не в базе. Хранить его в
// IndexedDB было бы неверно по существу: журнал описывает ТЕКУЩИЙ запуск
// приложения, и запись прошлого запуска в нём вводила бы в заблуждение
// ("почему реле не отвечало?" — а это было вчера). Живёт от загрузки
// страницы до перезагрузки, ровно как и предмет описания.
//
// Размер ограничен жёстко: экран диагностики может быть открыт часами, а
// переподключения к реле пишутся сюда каждый раз. Без потолка это утечка.
const MAX_ENTRIES = 200;

const entries = [];
const listeners = new Set();
const startedAt = Date.now();

function push(level, message) {
	entries.push({ at: Date.now() - startedAt, level, message });
	if (entries.length > MAX_ENTRIES) entries.shift();
	for (const listener of listeners) listener();
}

// level: "info" | "warn" | "error". Разделение нужно не для цвета, а для
// счётчика проблем на экране — "сколько всего записей" бесполезно,
// "сколько из них тревожных" отвечает на вопрос человека.
export function logInfo(message) {
	push("info", message);
}

export function logWarn(message) {
	push("warn", message);
}

export function logError(message) {
	push("error", message);
}

export function getBootLog() {
	return entries.slice();
}

export function countProblems() {
	return entries.filter((e) => e.level !== "info").length;
}

// Подписка для UI. Возвращает функцию отписки — обязательна, иначе
// размонтированный экран диагностики продолжит держать ссылку и
// перерисовываться в фоне при каждом переподключении реле.
export function subscribeBootLog(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

// Только для тестов — в приложении журнал не сбрасывается никогда.
export function resetBootLogForTests() {
	entries.length = 0;
	listeners.clear();
}
