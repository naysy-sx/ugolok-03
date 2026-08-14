// Rooms, этап 5 — audio-graph.js. Тесты до кода (skill п.14). Контракт и
// design-записка — PROCESS-DOCS/CONTRACTS.md/DESIGN.md "Rooms — Этап 5".
// Фейковый AudioContext (DI, тот же приём, что media-controller.js/RTCPeerConnectionImpl) —
// реальный Web Audio недоступен в node:test, это ровно граница ответственности
// audio-graph.js (топология графа, не сам Web Audio).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAudioGraph } from "../src/domain/rooms/adapters/audio-graph.js";

function fakeNode(kind, registry) {
	const node = {
		kind,
		connections: [],
		disconnectCalls: 0,
		connect(target) {
			node.connections.push(target);
			return target;
		},
		disconnect() {
			node.disconnectCalls += 1;
			node.connections = [];
		},
	};
	registry.push(node);
	return node;
}

function fakeAnalyserFactory(registry) {
	return () => {
		const node = fakeNode("analyser", registry);
		node.fftSize = 2048;
		node.frequencyBinCount = 1024;
		node.getByteFrequencyDataCalls = 0;
		node.getByteTimeDomainDataCalls = 0;
		node.getByteFrequencyData = (arr) => {
			node.getByteFrequencyDataCalls += 1;
			arr.fill(1);
		};
		node.getByteTimeDomainData = (arr) => {
			node.getByteTimeDomainDataCalls += 1;
			arr.fill(128);
		};
		return node;
	};
}

function fakeGainFactory(registry) {
	return () => {
		const node = fakeNode("gain", registry);
		node.gain = {
			value: 1,
			setTargetAtTimeCalls: [],
			setTargetAtTime(target, startTime, timeConstant) {
				node.gain.setTargetAtTimeCalls.push({ target, startTime, timeConstant });
			},
		};
		return node;
	};
}

function setup() {
	const nodes = [];
	const sources = [];
	let currentTime = 0;
	let closeCalls = 0;
	class FakeAudioContext {
		constructor() {
			this.destination = fakeNode("destination", nodes);
			this.currentTime = currentTime;
		}
		createAnalyser() {
			return fakeAnalyserFactory(nodes)();
		}
		createGain() {
			return fakeGainFactory(nodes)();
		}
		createMediaStreamSource(stream) {
			const node = fakeNode("source", nodes);
			node.stream = stream;
			sources.push(node);
			return node;
		}
		close() {
			closeCalls += 1;
			return Promise.resolve();
		}
	}
	const graph = createAudioGraph({ AudioContextImpl: FakeAudioContext });
	return { graph, nodes, sources, getCloseCalls: () => closeCalls };
}

test("addStream(isSelf:false): source подключается к per-участниковому анализатору уровня, к шинному анализатору спектрограммы И к masterGain", () => {
	const { graph, nodes, sources } = setup();
	graph.addStream("bob", { id: "bob-stream" }, { isSelf: false });

	assert.equal(sources.length, 1);
	const source = sources[0];
	assert.equal(source.connections.length, 3, "три подключения: level-анализатор, spectrogram-анализатор, masterGain");

	const analysers = nodes.filter((n) => n.kind === "analyser");
	assert.equal(analysers.length, 2, "один шинный (spectrogram) + один per-участнику (level)");
	const levelAnalyser = analysers.find((a) => a.fftSize === 256);
	assert.ok(levelAnalyser, "per-участнику анализатор должен иметь fftSize=256 (ROOMS-ALGO §7.3)");
	assert.ok(source.connections.includes(levelAnalyser));

	const gainNodes = nodes.filter((n) => n.kind === "gain");
	const masterGain = gainNodes[0]; // единственный gain, создан при createAudioGraph
	assert.ok(source.connections.includes(masterGain), "НЕ-свой поток обязан идти в masterGain (звук слышен)");
});

test("addStream(isSelf:true): source НЕ подключается к masterGain (самопрослушивание исключено из звука)", () => {
	const { graph, sources, nodes } = setup();
	graph.addStream("self", { id: "self-stream" }, { isSelf: true });

	const source = sources[0];
	const gainNodes = nodes.filter((n) => n.kind === "gain");
	const masterGain = gainNodes[0];
	assert.ok(!source.connections.includes(masterGain), "свой поток НЕ должен идти в masterGain — иначе эхо/самопрослушивание");
	assert.equal(source.connections.length, 2, "только level-анализатор и spectrogram-анализатор, без masterGain");
});

test("addStream(isSelf:true) ВСЁ РАВНО подключается к шинному анализатору спектрограммы — виден на общей картине комнаты и в 'кто говорит'", () => {
	const { graph, sources, nodes } = setup();
	graph.addStream("self", { id: "self-stream" }, { isSelf: true });
	const source = sources[0];
	const spectrogramAnalyser = nodes.find((n) => n.kind === "analyser" && n.fftSize === 2048);
	assert.ok(source.connections.includes(spectrogramAnalyser));
});

test("И15: getSpectrum() вызывает getByteFrequencyData ТОЛЬКО у шинного анализатора, не более раза за вызов, независимо от числа участников", () => {
	const { graph, nodes } = setup();
	for (const pubkey of ["a", "b", "c", "d", "e"]) graph.addStream(pubkey, { id: pubkey }, { isSelf: pubkey === "a" });

	graph.getSpectrum();

	const analysers = nodes.filter((n) => n.kind === "analyser");
	const spectrogramAnalyser = analysers.find((a) => a.fftSize === 2048);
	const levelAnalysers = analysers.filter((a) => a.fftSize === 256);
	assert.equal(levelAnalysers.length, 5, "по одному per-участнику анализатору на каждого из пяти");
	assert.equal(spectrogramAnalyser.getByteFrequencyDataCalls, 1);
	for (const levelAnalyser of levelAnalysers) {
		assert.equal(levelAnalyser.getByteFrequencyDataCalls, 0, "per-участнику анализатор НИКОГДА не вызывает getByteFrequencyData");
	}
});

test("getLevels(): вызывает getByteTimeDomainData (не getByteFrequencyData) на каждом per-участнику анализаторе, возвращает Map по pubkey", () => {
	const { graph, nodes } = setup();
	graph.addStream("bob", { id: "bob" }, { isSelf: false });
	graph.addStream("self", { id: "self" }, { isSelf: true });

	const levels = graph.getLevels();

	assert.equal(levels.size, 2);
	assert.ok(levels.has("bob"));
	assert.ok(levels.has("self"));
	for (const { level, speaking } of levels.values()) {
		assert.equal(typeof level, "number");
		assert.equal(typeof speaking, "boolean");
	}
	const levelAnalysers = nodes.filter((n) => n.kind === "analyser" && n.fftSize === 256);
	for (const a of levelAnalysers) {
		assert.equal(a.getByteTimeDomainDataCalls, 1);
		assert.equal(a.getByteFrequencyDataCalls, 0);
	}
});

test("setMasterGain(v): использует gain.setTargetAtTime, НЕ прямое присваивание gain.value (иначе щелчок)", () => {
	const { graph, nodes } = setup();
	const masterGain = nodes.find((n) => n.kind === "gain");
	graph.setMasterGain(0.5);

	assert.equal(masterGain.gain.setTargetAtTimeCalls.length, 1);
	assert.equal(masterGain.gain.setTargetAtTimeCalls[0].target, 0.5);
	assert.equal(masterGain.gain.value, 1, "value НЕ присвоен напрямую — остался дефолтным");
});

test("removeStream(pubkey): отключает source, повторный вызов и вызов для неизвестного pubkey — no-op, не бросает", () => {
	const { graph, sources } = setup();
	graph.addStream("bob", { id: "bob" }, { isSelf: false });
	const source = sources[0];

	graph.removeStream("bob");
	assert.equal(source.disconnectCalls, 1);

	assert.doesNotThrow(() => graph.removeStream("bob")); // повторно — уже удалён
	assert.doesNotThrow(() => graph.removeStream("nobody"))
});

test("removeStream(pubkey): убирает участника из getLevels() (больше не отслеживается)", () => {
	const { graph } = setup();
	graph.addStream("bob", { id: "bob" }, { isSelf: false });
	assert.ok(graph.getLevels().has("bob"));
	graph.removeStream("bob");
	assert.ok(!graph.getLevels().has("bob"));
});

test("close(): отключает все активные источники и masterGain/spectrogram-анализатор, закрывает AudioContext", () => {
	const { graph, sources, nodes, getCloseCalls } = setup();
	graph.addStream("bob", { id: "bob" }, { isSelf: false });
	graph.addStream("self", { id: "self" }, { isSelf: true });

	graph.close();

	for (const source of sources) assert.equal(source.disconnectCalls, 1);
	const masterGain = nodes.find((n) => n.kind === "gain");
	assert.equal(masterGain.disconnectCalls, 1);
	const spectrogramAnalyser = nodes.find((n) => n.kind === "analyser" && n.fftSize === 2048);
	assert.equal(spectrogramAnalyser.disconnectCalls, 1);
	assert.equal(getCloseCalls(), 1);
});

// --- Адверсарная фаза (skill п.19) ---

test("адверсарно: addStream дважды с тем же pubkey (переприсоединение) — старый source отключается (не утекает), актуален только новый", () => {
	const { graph, sources } = setup();
	graph.addStream("bob", { id: "bob-old" }, { isSelf: false });
	const oldSource = sources[0];
	graph.addStream("bob", { id: "bob-new" }, { isSelf: false });

	assert.equal(sources.length, 2, "оба source физически созданы");
	assert.equal(oldSource.disconnectCalls, 1, "старый source отключён автоматически — addStream сам защищается от утечки");
	const levels = graph.getLevels();
	assert.equal(levels.size, 1, "Map по pubkey схлопывает дубликат — только последняя запись отслеживается");
});

test("адверсарно: getSpectrum()/getLevels() без единого addStream — не бросает, возвращает пустую карту/валидный буфер", () => {
	const { graph } = setup();
	assert.doesNotThrow(() => graph.getSpectrum());
	const levels = graph.getLevels();
	assert.equal(levels.size, 0);
});

test("адверсарно: close() без единого addStream — не бросает", () => {
	const { graph } = setup();
	assert.doesNotThrow(() => graph.close());
});
