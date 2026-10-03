// push-forward.mjs — пересылка событий мосту push-уведомлений (П0.3 решение
// (Б): путь ЗАПИСИ, не REQ-подписка — см. PROCESS-DOCS/NATIVE/PUSH-E0-REPORT.md).
//
// Разделение как у write-policy.mjs/whitelist-plugin.mjs: здесь — чистые
// функции (что пересылать, в каком виде), тестируются без сети и без strfry;
// сам fetch — единственная сторона с эффектом, инъекция для теста.
//
// Что уходит мосту: ТОЛЬКО kind и tags. Ни id, ни pubkey (для gift wrap это
// одноразовый ключ отправителя — бесполезен и не нужен для сопоставления),
// ни content, ни sig — мост сопоставляет получателя по тегу p/h (agent/internal/
// pushbridge/matcher.go), содержимое ему не нужно и не должно быть доступно
// (ИП3, А3).

// Категории из матрицы П0.1: личные/заявки (gift wrap), MLS-группы, звонки.
// Каналы (30060 и т.п.) сюда сознательно не входят — В2 по умолчанию.
export const PUSH_RELEVANT_KINDS = new Set([1059, 445, 20075]);

export function shouldForward(event) {
	return PUSH_RELEVANT_KINDS.has(event?.kind);
}

export function buildForwardPayload(event) {
	return { kind: event.kind, tags: event.tags ?? [] };
}

// forward — строго не блокирует вызывающего (П0.3: «плагин должен пересылать
// событие мосту строго асинхронно, не блокируя и не завися от решения
// принять/отклонить само событие»). Не возвращает промис вызывающему намеренно —
// вызывающий код (whitelist-plugin.mjs) не должен даже иметь возможность
// случайно на него await'нуть. Ошибки/таймаут моста проглатываются здесь же
// (ИП7: отказ моста не должен быть виден остальной части relay).
export function forward(event, { url, token, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
	if (!url || !token) return; // push не настроен на этом острове (ИП6) — тихо ничего не делаем
	if (!shouldForward(event)) return;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	fetchImpl(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(buildForwardPayload(event)),
		signal: controller.signal,
	})
		.catch(() => {
			// Намеренно молча: см. заголовок файла, ИП7. Отдельной метрики отказов
			// моста здесь нет — это внутренняя эксплуатационная деталь моста
			// (у него свои логи), не relay.
		})
		.finally(() => clearTimeout(timer));
}
