// MEDIA-PERF-TZ-5.md §2 — общий лимит параллелизма на ВЕСЬ origin вместо
// трёх независимых лимитов "внутри одного вызова" (GET_RANGE_CONCURRENCY в
// content.js, WINDOW_CONCURRENCY в player-session.js — оба остаются как
// есть, это второй уровень поверх очереди, не замена). Живой замер
// (§0 того же ТЗ) показал: десять открытых вложений дают до шестидесяти
// одновременных потоков к одному origin, и именно конкуренция запросов
// друг с другом — источник растущей задержки (2.8с -> 3.8с на чанк), не
// нехватка полосы (см. §0 п.1: суммарно ~4 МБ/с успевает пройти).
//
// Чистый модуль (без DOM, без fetch — принцип разделения, тот же, что в
// player-bridge.js/sw-timeout.js): обвязка "что реально оборачивать" — в
// blossom-queue.js/blob.js.
export const PRIORITY = {
	PLAYER: 0, // активное воспроизведение <video>/<audio> через мост SW
	OVERLAY: 1, // полноэкранный просмотр картинки — пользователь смотрит прямо сейчас
	PREVIEW: 2, // превью в пузыре/ленте, миниатюры, фоновая подкачка
};

// playerMax + otherMax > limit НАМЕРЕННО (MEDIA-PERF-TZ-5.md §2) —
// пересечение это общий пул, который занимается по приоритету, а разница
// (limit - otherMax и limit - playerMax) гарантирует каждой стороне
// минимум слотов независимо от того, чем занят весь остальной пул.
// Голодание невозможно ни в одну сторону без стареющих приоритетов.
export function createRequestQueue({ limit, playerMax, otherMax }) {
	let seqCounter = 0;
	let running = 0;
	let runningPlayer = 0;
	let runningOther = 0;
	const queue = []; // { priority, seq, settle }

	function bucketCount(priority) {
		return priority === PRIORITY.PLAYER ? runningPlayer : runningOther;
	}

	function bucketMax(priority) {
		return priority === PRIORITY.PLAYER ? playerMax : otherMax;
	}

	function canStart(priority) {
		return running < limit && bucketCount(priority) < bucketMax(priority);
	}

	// Очередь НЕ поддерживается отсортированной (вставка — push, O(1)); выбор
	// следующей задачи — скан на каждый освободившийся слот. При типичных
	// размерах очереди (единицы-десятки задач на одну открытую сессию медиа)
	// это дешевле, чем держать структуру отсортированной на каждую
	// вставку/отмену. Критерий: сначала меньший priority (число), внутри
	// одного приоритета — меньший seq (раньше поставлен, FIFO); задачи,
	// чей "бакет" (player/other) уже упёрся в свой потолок, пропускаются —
	// именно так проток PLAYER не может уморить голодом OVERLAY/PREVIEW и
	// наоборот.
	function pickNext() {
		let bestIdx = -1;
		for (let i = 0; i < queue.length; i++) {
			const item = queue[i];
			if (!canStart(item.priority)) continue;
			if (bestIdx === -1 || item.priority < queue[bestIdx].priority || (item.priority === queue[bestIdx].priority && item.seq < queue[bestIdx].seq)) {
				bestIdx = i;
			}
		}
		if (bestIdx === -1) return;
		const [item] = queue.splice(bestIdx, 1);
		running++;
		if (item.priority === PRIORITY.PLAYER) runningPlayer++;
		else runningOther++;
		item.settle();
	}

	function release(priority) {
		running--;
		if (priority === PRIORITY.PLAYER) runningPlayer--;
		else runningOther--;
		pickNext();
	}

	// signal уже отменён К МОМЕНТУ постановки, либо отменён ДО старта -> задача
	// не запускается вовсе, промис отклоняется AbortError (перемотка не должна
	// занимать слот устаревшим чанком). Отмена ПОСЛЕ старта очередь не трогает —
	// прерывание доносит сам fn() через тот же signal, который вызывающая
	// сторона обязана передать и туда (это ответственность обвязки, не этого
	// модуля).
	function schedule(priority, fn, { signal } = {}) {
		if (signal?.aborted) return Promise.reject(new DOMException("Отменено", "AbortError"));

		return new Promise((resolve, reject) => {
			let started = false;
			const item = { priority, seq: seqCounter++, settle: null };

			function onAbort() {
				if (started) return;
				const idx = queue.indexOf(item);
				if (idx === -1) return;
				queue.splice(idx, 1);
				reject(new DOMException("Отменено", "AbortError"));
			}

			item.settle = () => {
				started = true;
				signal?.removeEventListener("abort", onAbort);
				fn().then(
					(value) => {
						release(priority);
						resolve(value);
					},
					(err) => {
						release(priority);
						reject(err);
					},
				);
			};

			signal?.addEventListener("abort", onAbort);
			queue.push(item);
			pickNext();
		});
	}

	return {
		schedule,
		get stats() {
			return {
				running,
				queued: queue.length,
				runningByPriority: { player: runningPlayer, other: runningOther },
			};
		},
	};
}
