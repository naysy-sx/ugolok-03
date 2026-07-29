// Ограничение параллелизма + отмена (задача 3.8 TASK.md, ALGO.MD §15:
// "генерировать только для попавших в область видимости... отменять
// задание, если элемент вышел из области видимости раньше, чем задание
// стартовало... ограничить параллелизм двумя-четырьмя задачами").
//
// Проверено: domain/content/rate-limiter.js — guard "не чаще раза в N мс
// на тип действия" (антиспам), другая задача (не ограничение ОДНОВРЕМЕННО
// работающих задач) — не годится буквально, здесь свой, маленький.
//
// cancel() до старта задачи — снимает её из очереди, task() не вызывается
// вовсе. cancel() ПОСЛЕ старта — no-op, задача докручивается (буквально
// по ALGO.MD: отмена работает для ещё НЕ стартовавших, не для прерывания
// уже идущих).
export function createThumbnailQueue(maxConcurrent = 3) {
	let running = 0;
	const pending = [];

	function runNext() {
		if (running >= maxConcurrent || pending.length === 0) return;
		const job = pending.shift();
		if (job.cancelled) {
			runNext();
			return;
		}
		running++;
		job.started = true;
		job
			.task()
			.then(job.resolve, job.reject)
			.finally(() => {
				running--;
				runNext();
			});
	}

	return {
		enqueue(task) {
			const job = { task, cancelled: false, started: false, resolve: null, reject: null };
			const promise = new Promise((resolve, reject) => {
				job.resolve = resolve;
				job.reject = reject;
				pending.push(job);
				runNext();
			});
			return {
				promise,
				cancel() {
					job.cancelled = true;
				},
			};
		},
		get runningCount() {
			return running;
		},
		get pendingCount() {
			return pending.length;
		},
	};
}
