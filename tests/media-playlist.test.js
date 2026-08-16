import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlaylist, classesPresent, stepInClass, firstOfClass, windowByBudget } from "../src/domain/media/playlist.js";

function ref(digest, mime, size) {
	return { digest, key: null, mime, name: digest, size, sourceKind: "attachment", sourceMeta: {} };
}

function sampleRefs() {
	return [
		ref("a1", "audio/mpeg", 100), // 0 audio
		ref("v1", "video/mp4", 200), // 1 video
		ref("i1", "image/png", 50), // 2 image
		ref("a1", "audio/mpeg", 100), // 3 dup audio -> deduped by default
		ref("i1", "image/png", 50), // 4 dup image -> NOT deduped by default
		ref("o1", "application/pdf", 10), // 5 other
	];
}

test("buildPlaylist: дедуп аудио/видео по умолчанию (первое вхождение), изображения не дедуплицируются", () => {
	const pl = buildPlaylist(sampleRefs());
	assert.deepEqual(
		pl.items.map((r) => r.digest),
		["a1", "v1", "i1", "i1", "o1"],
	);
});

test("buildPlaylist: cls присваивает 0=audio,1=video,2=image,3=other по фиксированному порядку", () => {
	const pl = buildPlaylist(sampleRefs());
	assert.deepEqual(Array.from(pl.cls), [0, 1, 2, 2, 3]);
});

test("buildPlaylist: idx содержит позиции своего класса по возрастанию", () => {
	const pl = buildPlaylist(sampleRefs());
	assert.deepEqual(Array.from(pl.idx.audio), [0]);
	assert.deepEqual(Array.from(pl.idx.video), [1]);
	assert.deepEqual(Array.from(pl.idx.image), [2, 3]);
});

test("buildPlaylist: rank — номер позиции внутри своего класса", () => {
	const pl = buildPlaylist(sampleRefs());
	assert.equal(pl.rank[0], 0); // единственный audio
	assert.equal(pl.rank[1], 0); // единственный video
	assert.equal(pl.rank[2], 0); // первый image
	assert.equal(pl.rank[3], 1); // второй image
});

test("buildPlaylist: pref — префиксные суммы размеров, длина items.length+1", () => {
	const pl = buildPlaylist(sampleRefs());
	assert.equal(pl.pref.length, pl.items.length + 1);
	assert.deepEqual(Array.from(pl.pref), [0, 100, 300, 350, 400, 410]);
});

test("buildPlaylist: dedupeClasses=[] отключает дедупликацию полностью", () => {
	const pl = buildPlaylist(sampleRefs(), { dedupeClasses: [] });
	assert.equal(pl.items.length, 6);
});

test("buildPlaylist: пустой вход даёт пустой плейлист без ошибок", () => {
	const pl = buildPlaylist([]);
	assert.equal(pl.items.length, 0);
	assert.deepEqual(Array.from(pl.pref), [0]);
});

test("classesPresent: только реально присутствующие классы true", () => {
	const pl = buildPlaylist([ref("i1", "image/png", 10)]);
	assert.deepEqual(classesPresent(pl), { audio: false, video: false, image: true });
});

test("classesPresent: пустой плейлист — всё false", () => {
	const pl = buildPlaylist([]);
	assert.deepEqual(classesPresent(pl), { audio: false, video: false, image: false });
});

test("stepInClass: следующий/предыдущий элемент того же класса", () => {
	const pl = buildPlaylist(sampleRefs());
	assert.equal(stepInClass(pl, 2, +1), 3); // image: rank0 -> rank1
	assert.equal(stepInClass(pl, 3, +1), -1); // конец класса image
	assert.equal(stepInClass(pl, 3, -1), 2);
	assert.equal(stepInClass(pl, 0, +1), -1); // единственный audio, некуда
	assert.equal(stepInClass(pl, 0, -1), -1);
});

test("firstOfClass: первая позиция класса, -1 если класса нет", () => {
	const pl = buildPlaylist(sampleRefs());
	assert.equal(firstOfClass(pl, "audio"), 0);
	assert.equal(firstOfClass(pl, "image"), 2);
	const emptyPl = buildPlaylist([ref("a", "audio/mpeg", 1)]);
	assert.equal(firstOfClass(emptyPl, "video"), -1);
});

test("stepInClass: не растёт по времени при |L| от 10 до 10^4 (Θ(1) — приёмка A этапа)", () => {
	function bigPlaylist(n) {
		const refs = [];
		for (let i = 0; i < n; i++) refs.push(ref(`v${i}`, "video/mp4", 1));
		return buildPlaylist(refs);
	}
	const small = bigPlaylist(10);
	const big = bigPlaylist(10000);
	const t0 = performance.now();
	for (let i = 0; i < 1000; i++) stepInClass(small, 5, +1);
	const tSmall = performance.now() - t0;
	const t1 = performance.now();
	for (let i = 0; i < 1000; i++) stepInClass(big, 5000, +1);
	const tBig = performance.now() - t1;
	assert.ok(tBig < tSmall * 20 + 50, `stepInClass похоже растёт с |L|: small=${tSmall}ms big=${tBig}ms`);
});

test("windowByBudget: включает position и не превышает бюджет байт", () => {
	const items = [100, 100, 100, 100, 100].map((s, i) => ref(`x${i}`, "image/png", s));
	const pl = buildPlaylist(items);
	const { l, r } = windowByBudget(pl, 2, 250, 5);
	assert.ok(l <= 2 && 2 < r, "окно обязано включать текущую позицию");
	assert.ok(pl.pref[r] - pl.pref[l] <= 250, "окно обязано укладываться в бюджет");
});

test("windowByBudget: наибольшее по включению — расширение в любую сторону нарушает бюджет или maxSpan", () => {
	const items = [100, 100, 100, 100, 100].map((s, i) => ref(`x${i}`, "image/png", s));
	const pl = buildPlaylist(items);
	const { l, r } = windowByBudget(pl, 2, 250, 5);
	const canExtendLeft = l > 0 && pl.pref[r] - pl.pref[l - 1] <= 250 && r - (l - 1) <= 5;
	const canExtendRight = r < pl.items.length && pl.pref[r + 1] - pl.pref[l] <= 250 && r + 1 - l <= 5;
	assert.equal(canExtendLeft, false);
	assert.equal(canExtendRight, false);
});

test("windowByBudget: ограничение maxSpan связывает раньше бюджета — окно ровно maxSpan вокруг позиции", () => {
	const items = [10, 10, 10, 10, 10].map((s, i) => ref(`x${i}`, "image/png", s));
	const pl = buildPlaylist(items);
	const { l, r } = windowByBudget(pl, 2, 10000, 3);
	assert.equal(r - l, 3);
	assert.equal(l, 1);
	assert.equal(r, 4);
});

test("windowByBudget: у края плейлиста окно не выходит за границы", () => {
	const items = [10, 10, 10].map((s, i) => ref(`x${i}`, "image/png", s));
	const pl = buildPlaylist(items);
	const { l, r } = windowByBudget(pl, 0, 10000, 5);
	assert.ok(l >= 0 && r <= pl.items.length);
	const last = windowByBudget(pl, 2, 10000, 5);
	assert.ok(last.l >= 0 && last.r <= pl.items.length);
});

test("windowByBudget: budgetBytes=0 или maxSpan<=1 -> минимальное окно из одного элемента", () => {
	const items = [10, 10, 10].map((s, i) => ref(`x${i}`, "image/png", s));
	const pl = buildPlaylist(items);
	assert.deepEqual(windowByBudget(pl, 1, 0, 5), { l: 1, r: 2 });
	assert.deepEqual(windowByBudget(pl, 1, 10000, 1), { l: 1, r: 2 });
});
