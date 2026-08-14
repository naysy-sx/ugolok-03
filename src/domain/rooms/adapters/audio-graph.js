// Rooms, этап 5 — Web Audio граф комнаты: спектрограмма + уровни по участникам +
// регулятор громкости. Контракт и design-записка: PROCESS-DOCS/CONTRACTS.md/
// DESIGN.md "Rooms — Этап 5". ROOMS-SPEC §4.4, ROOMS-ALGO §7.
import { computeRms, createLevelTracker } from "../level-meter.js";

const SPECTROGRAM_FFT_SIZE = 2048;
const LEVEL_FFT_SIZE = 256;
// Постоянная времени setTargetAtTime — быстро, но без щелчка мгновенного присваивания.
const GAIN_TIME_CONSTANT = 0.01;

export function createAudioGraph({ AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
	const ctx = new AudioContextImpl();
	// Единственный AnalyserNode спектрограммы — И15 по построению (design-записка):
	// это ЕДИНСТВЕННОЕ место во всём графе, где вызывается getByteFrequencyData.
	const spectrogramAnalyser = ctx.createAnalyser();
	spectrogramAnalyser.fftSize = SPECTROGRAM_FFT_SIZE;
	const spectrumBuffer = new Uint8Array(spectrogramAnalyser.frequencyBinCount);

	// Все НЕ-свои потоки суммируются здесь -> единственная точка громкости ->
	// destination. Свой поток НИКОГДА сюда не подключается (design-решение:
	// самопрослушивание исключено из звука, но не из визуализации/уровня — иначе
	// пользователь слышал бы собственный микрофон).
	const masterGain = ctx.createGain();
	masterGain.connect(ctx.destination);

	const streams = new Map(); // pubkey -> {source, levelAnalyser, levelTracker, isSelf}

	function addStream(pubkey, stream, { isSelf = false } = {}) {
		if (streams.has(pubkey)) removeStream(pubkey); // защита от утечки узла при переприсоединении того же pubkey
		const source = ctx.createMediaStreamSource(stream);

		const levelAnalyser = ctx.createAnalyser();
		levelAnalyser.fftSize = LEVEL_FFT_SIZE;
		source.connect(levelAnalyser);

		// Все потоки (включая свой) видны на общей спектрограмме комнаты —
		// ROOMS-ALGO §7.3: "нужен на каждого", не "на каждого кроме себя".
		source.connect(spectrogramAnalyser);

		if (!isSelf) source.connect(masterGain);

		streams.set(pubkey, { source, levelAnalyser, levelTracker: createLevelTracker(), isSelf });
	}

	function removeStream(pubkey) {
		const entry = streams.get(pubkey);
		if (!entry) return;
		entry.source.disconnect(); // отключает ВСЕ исходящие соединения этого источника разом
		streams.delete(pubkey);
	}

	function setMasterGain(v) {
		masterGain.gain.setTargetAtTime(v, ctx.currentTime, GAIN_TIME_CONSTANT);
	}

	function getSpectrum() {
		spectrogramAnalyser.getByteFrequencyData(spectrumBuffer);
		return spectrumBuffer;
	}

	function getLevels() {
		const result = new Map();
		for (const [pubkey, entry] of streams) {
			const timeDomainBuffer = new Uint8Array(entry.levelAnalyser.fftSize);
			entry.levelAnalyser.getByteTimeDomainData(timeDomainBuffer);
			const rms = computeRms(timeDomainBuffer);
			result.set(pubkey, entry.levelTracker.update(rms));
		}
		return result;
	}

	function close() {
		for (const pubkey of [...streams.keys()]) removeStream(pubkey);
		masterGain.disconnect();
		spectrogramAnalyser.disconnect();
		ctx.close();
	}

	return { addStream, removeStream, setMasterGain, getSpectrum, getLevels, close };
}
