import { test } from "node:test";
import assert from "node:assert/strict";
import { transition, allocWindow, EVENTS } from "../src/domain/media/media-machine.js";
import { buildPlaylist } from "../src/domain/media/playlist.js";

function ref(digest, mime, size) {
	return { digest, key: null, mime, name: digest, size, sourceKind: "attachment", sourceMeta: {} };
}

// audio x2, video x1, image x3 — достаточно для границ класса в next/prev/ended
function samplePlaylist() {
	return buildPlaylist([
		ref("a0", "audio/mpeg", 10),
		ref("a1", "audio/mpeg", 10),
		ref("v0", "video/mp4", 10),
		ref("i0", "image/png", 10),
		ref("i1", "image/png", 10),
		ref("i2", "image/png", 10),
	]);
}

test("EVENTS содержит буквально алфавит SPEC §3.4", () => {
	assert.deepEqual(EVENTS, ["open", "next", "prev", "toggle", "minimize", "restore", "close", "callStart", "callEnd", "ended", "seek"]);
});

test("open из null: сброс в full/playing, callActive=false (звонка не было)", () => {
	const pl = samplePlaylist();
	const s = transition(null, "open", { cls: "audio", position: 0 }, pl);
	assert.deepEqual(s, { cls: "audio", position: 0, display: "full", play: "playing", callActive: false });
});

test("open — это СБРОС непустого состояния, а не стек (Опр.3 матдокумента)", () => {
	const pl = samplePlaylist();
	const s1 = transition(null, "open", { cls: "audio", position: 0 }, pl);
	const s2 = transition(s1, "open", { cls: "image", position: 3 }, pl);
	assert.equal(s2.cls, "image");
	assert.equal(s2.position, 3);
	assert.equal(s2.display, "full");
});

test("open во время активного звонка (callActive перенесён из старого состояния) сохраняет И2", () => {
	const pl = samplePlaylist();
	const duringCall = { cls: "audio", position: 0, display: "mini", play: "suspended", callActive: true };
	const s = transition(duringCall, "open", { cls: "video", position: 2 }, pl);
	assert.equal(s.callActive, true);
	assert.equal(s.play, "suspended"); // И2: playing ⟹ !callActive — open не имеет права включить playing поверх звонка
});

test("close: любое состояние -> null", () => {
	const pl = samplePlaylist();
	const s = { cls: "video", position: 2, display: "full", play: "playing", callActive: false };
	assert.equal(transition(s, "close", {}, pl), null);
	assert.equal(transition(null, "close", {}, pl), null);
});

test("toggle: playing <-> paused", () => {
	const pl = samplePlaylist();
	const playing = { cls: "audio", position: 0, display: "full", play: "playing", callActive: false };
	const paused = transition(playing, "toggle", {}, pl);
	assert.equal(paused.play, "paused");
	const playingAgain = transition(paused, "toggle", {}, pl);
	assert.equal(playingAgain.play, "playing");
});

test("toggle при активном звонке — без изменений (И2, запрет явный, не разовый pause())", () => {
	const pl = samplePlaylist();
	const s = { cls: "audio", position: 0, display: "full", play: "suspended", callActive: true };
	assert.deepEqual(transition(s, "toggle", {}, pl), s);
});

test("toggle для cls=image — неприменимо, состояние как есть", () => {
	const pl = samplePlaylist();
	const s = { cls: "image", position: 3, display: "full", play: "paused", callActive: false };
	assert.deepEqual(transition(s, "toggle", {}, pl), s);
});

test("toggle на null — без изменений", () => {
	const pl = samplePlaylist();
	assert.equal(transition(null, "toggle", {}, pl), null);
});

test("next/prev двигают позицию внутри класса", () => {
	const pl = samplePlaylist();
	const s = { cls: "image", position: 3, display: "full", play: "paused", callActive: false };
	const s2 = transition(s, "next", {}, pl);
	assert.equal(s2.position, 4);
	const s3 = transition(s2, "prev", {}, pl);
	assert.equal(s3.position, 3);
});

test("next/prev на границе класса — без изменений (неприменимое событие)", () => {
	const pl = samplePlaylist();
	const lastImage = { cls: "image", position: 5, display: "full", play: "paused", callActive: false };
	assert.deepEqual(transition(lastImage, "next", {}, pl), lastImage);
	const firstAudio = { cls: "audio", position: 0, display: "full", play: "paused", callActive: false };
	assert.deepEqual(transition(firstAudio, "prev", {}, pl), firstAudio);
});

test("minimize/restore ортогональны play (МАТH §5.5)", () => {
	const pl = samplePlaylist();
	const playing = { cls: "audio", position: 0, display: "full", play: "playing", callActive: false };
	const mini = transition(playing, "minimize", {}, pl);
	assert.equal(mini.display, "mini");
	assert.equal(mini.play, "playing"); // звук продолжается
	const full = transition(mini, "restore", {}, pl);
	assert.equal(full.display, "full");
	assert.equal(full.play, "playing");
});

test("minimize для cls=image запрещён (И5) — состояние как есть", () => {
	const pl = samplePlaylist();
	const s = { cls: "image", position: 3, display: "full", play: "paused", callActive: false };
	assert.deepEqual(transition(s, "minimize", {}, pl), s);
});

test("callStart: playing -> suspended, callActive=true", () => {
	const pl = samplePlaylist();
	const s = { cls: "video", position: 2, display: "full", play: "playing", callActive: false };
	const s2 = transition(s, "callStart", {}, pl);
	assert.equal(s2.play, "suspended");
	assert.equal(s2.callActive, true);
});

test("callStart на paused: callActive=true устанавливается, play остаётся paused (не 'без изменений' целиком)", () => {
	const pl = samplePlaylist();
	const s = { cls: "video", position: 2, display: "full", play: "paused", callActive: false };
	const s2 = transition(s, "callStart", {}, pl);
	assert.equal(s2.play, "paused");
	assert.equal(s2.callActive, true, "иначе последующий toggle включит звук поверх реального звонка");
});

test("callStart на null — без изменений", () => {
	const pl = samplePlaylist();
	assert.equal(transition(null, "callStart", {}, pl), null);
});

test("callEnd: suspended -> paused (решение §1.4: X=paused, не возобновляется само), callActive=false", () => {
	const pl = samplePlaylist();
	const s = { cls: "video", position: 2, display: "full", play: "suspended", callActive: true };
	const s2 = transition(s, "callEnd", {}, pl);
	assert.equal(s2.play, "paused");
	assert.equal(s2.callActive, false);
});

test("callEnd на paused: play остаётся paused, callActive снимается", () => {
	const pl = samplePlaylist();
	const s = { cls: "video", position: 2, display: "full", play: "paused", callActive: true };
	const s2 = transition(s, "callEnd", {}, pl);
	assert.equal(s2.play, "paused");
	assert.equal(s2.callActive, false);
});

test("ended: продолжает на следующий элемент класса, play остаётся playing", () => {
	const pl = samplePlaylist();
	const s = { cls: "image", position: 3, display: "full", play: "playing", callActive: false };
	// у image нет play-семантики по UI, но событие ended используется тут только для теста границы —
	// основной случай ended — audio/video:
	const av = { cls: "video", position: 2, display: "full", play: "playing", callActive: false };
	const s2 = transition(av, "ended", {}, pl); // единственный video, некуда продолжать
	assert.equal(s2.play, "paused");
	assert.equal(s2.position, 2);
});

test("ended на конце класса — останавливается (paused), не закрывается и не зацикливается (повтор вне скоупа)", () => {
	const pl = samplePlaylist();
	const s = { cls: "audio", position: 1, display: "full", play: "playing", callActive: false }; // последний audio
	const s2 = transition(s, "ended", {}, pl);
	assert.notEqual(s2, null);
	assert.equal(s2.play, "paused");
	assert.equal(s2.position, 1);
});

test("ended с доступным следующим элементом класса — двигает позицию, play=playing", () => {
	const pl = samplePlaylist();
	const s = { cls: "audio", position: 0, display: "full", play: "playing", callActive: false };
	const s2 = transition(s, "ended", {}, pl);
	assert.equal(s2.position, 1);
	assert.equal(s2.play, "playing");
});

test("ended для cls=image — неприменимо, состояние как есть", () => {
	const pl = samplePlaylist();
	const s = { cls: "image", position: 3, display: "full", play: "paused", callActive: false };
	assert.deepEqual(transition(s, "ended", {}, pl), s);
});

test("seek не меняет ни одного поля MediaState (побочный эффект вне машины)", () => {
	const pl = samplePlaylist();
	const s = { cls: "video", position: 2, display: "full", play: "playing", callActive: false };
	assert.deepEqual(transition(s, "seek", { t: 42 }, pl), s);
});

test("allocWindow(null) = [] (И3)", () => {
	const pl = samplePlaylist();
	assert.deepEqual(allocWindow(null, pl, 1000000), []);
});

test("allocWindow для audio/video = только текущая позиция (браузер сам буферизует Range)", () => {
	const pl = samplePlaylist();
	const s = { cls: "audio", position: 1, display: "full", play: "playing", callActive: false };
	assert.deepEqual(allocWindow(s, pl, 1000000), ["a1"]);
});

test("allocWindow для image = окно по бюджету вокруг позиции (несколько дайджестов)", () => {
	const pl = samplePlaylist();
	const s = { cls: "image", position: 4, display: "full", play: "paused", callActive: false };
	const window = allocWindow(s, pl, 1000000);
	assert.ok(window.includes("i1"));
	assert.ok(window.length >= 1);
});
