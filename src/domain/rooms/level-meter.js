// Rooms, этап 5 — уровень громкости без FFT. ROOMS-ALGO §7.3, буквально.
// Контракт и design-записка: PROCESS-DOCS/CONTRACTS.md/DESIGN.md "Rooms — Этап 5".
//
// getByteTimeDomainData (НЕ getByteFrequencyData) -> RMS -> EMA -> гистерезис.
// Один трекер на участника (включая себя), живёт внутри audio-graph.js.

export function computeRms(timeDomainData) {
	let sumSquares = 0;
	for (let i = 0; i < timeDomainData.length; i++) {
		const v = (timeDomainData[i] - 128) / 128;
		sumSquares += v * v;
	}
	return Math.sqrt(sumSquares / timeDomainData.length);
}

export function createLevelTracker({ alpha = 0.3, onThreshold = 0.15, offThreshold = 0.1 } = {}) {
	let level = 0;
	let speaking = false;

	function update(rms) {
		level = alpha * rms + (1 - alpha) * level;
		// Гистерезис: false->true только при пересечении onThreshold снизу вверх,
		// true->false только при пересечении offThreshold сверху вниз — в мёртвой
		// зоне (offThreshold, onThreshold) состояние не меняется (иначе дребезг
		// индикатора "говорит" на границе, ROOMS-ALGO §7.3).
		if (!speaking && level >= onThreshold) speaking = true;
		else if (speaking && level <= offThreshold) speaking = false;
		return { level, speaking };
	}

	function get() {
		return { level, speaking };
	}

	return { update, get };
}
