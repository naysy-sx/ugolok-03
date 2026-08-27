import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isVisual,
	isFileChip,
	isAudioChip,
	isVoice,
	inferLayout,
	resolveLayout,
	planBubbleAttachments,
	truncateFileName,
} from "../src/ui/components/bubble-attachment-plan.js";

function img(extra = {}) {
	return { type: "image", name: "a.jpg", ...extra };
}
function vid(extra = {}) {
	return { type: "video", name: "a.mp4", ...extra };
}
function pdf(extra = {}) {
	return { type: "file", name: "a.pdf", mime: "application/pdf", ...extra };
}
function mp3(extra = {}) {
	return { type: "audio", name: "a.mp3", mime: "audio/mpeg", ...extra };
}
function voice(extra = {}) {
	return { type: "audio", voice: true, name: "voice.webm", ...extra };
}

test("isVisual: только image и video", () => {
	assert.equal(isVisual(img()), true);
	assert.equal(isVisual(vid()), true);
	assert.equal(isVisual(pdf()), false);
	assert.equal(isVisual(mp3()), false);
	assert.equal(isVisual(voice()), false);
	assert.equal(isVisual(undefined), false);
});

test("isVoice: audio с voice или voiceInline", () => {
	assert.equal(isVoice(voice()), true);
	assert.equal(isVoice({ type: "audio", voiceInline: "aaaa" }), true);
	assert.equal(isVoice(mp3()), false);
	assert.equal(isVoice(img()), false);
	assert.equal(isVoice(undefined), false);
});

test("isAudioChip: неголосовое аудио", () => {
	assert.equal(isAudioChip(mp3()), true);
	assert.equal(isAudioChip(voice()), false);
	assert.equal(isAudioChip(pdf()), false);
});

test("isFileChip: документы, не visual/audio/voice", () => {
	assert.equal(isFileChip(pdf()), true);
	assert.equal(isFileChip(img()), false);
	assert.equal(isFileChip(mp3()), false);
	assert.equal(isFileChip(voice()), false);
});

test("inferLayout: 0 → null (нет кластера)", () => {
	assert.equal(inferLayout(0), null);
	assert.equal(inferLayout(undefined), null);
});

test("inferLayout: 1 → single, 2 → duo, 3 → trio, 4+ → quad", () => {
	assert.equal(inferLayout(1), "single");
	assert.equal(inferLayout(2), "duo");
	assert.equal(inferLayout(3), "trio");
	assert.equal(inferLayout(4), "quad");
	assert.equal(inferLayout(7), "quad");
});

test("planBubbleAttachments: undefined / [] → пустые массивы, layout null", () => {
	const empty = { layout: null, visual: [], files: [], audios: [], voices: [] };
	assert.deepEqual(planBubbleAttachments(undefined), empty);
	assert.deepEqual(planBubbleAttachments([]), empty);
});

test("planBubbleAttachments: 1 image → visual[1], layout single", () => {
	const a = img();
	const plan = planBubbleAttachments([a]);
	assert.equal(plan.layout, "single");
	assert.deepEqual(plan.visual, [a]);
	assert.deepEqual(plan.files, []);
});

test("planBubbleAttachments: 2 video → duo", () => {
	const plan = planBubbleAttachments([vid({ name: "a" }), vid({ name: "b" })]);
	assert.equal(plan.layout, "duo");
	assert.equal(plan.visual.length, 2);
});

test("planBubbleAttachments: 3 image → trio", () => {
	const plan = planBubbleAttachments([img(), img(), img()]);
	assert.equal(plan.layout, "trio");
	assert.equal(plan.visual.length, 3);
});

test("planBubbleAttachments: 4 image → quad", () => {
	const plan = planBubbleAttachments([img(), img(), img(), img()]);
	assert.equal(plan.layout, "quad");
	assert.equal(plan.visual.length, 4);
});

test("planBubbleAttachments: 6 image → layout quad, visual.length 6 (обрезание только в рендере)", () => {
	const plan = planBubbleAttachments([img(), img(), img(), img(), img(), img()]);
	assert.equal(plan.layout, "quad");
	assert.equal(plan.visual.length, 6);
});

test("planBubbleAttachments: image+video+pdf+mp3+voice → visual 2, files 1, audios 1, voices 1", () => {
	const a = img();
	const b = vid();
	const c = pdf();
	const d = mp3();
	const e = voice();
	const plan = planBubbleAttachments([a, b, c, d, e]);
	assert.deepEqual(plan.visual, [a, b]);
	assert.deepEqual(plan.files, [c]);
	assert.deepEqual(plan.audios, [d]);
	assert.deepEqual(plan.voices, [e]);
	assert.equal(plan.layout, "duo");
});

test("resolveLayout: layout hero на первом visual, даже если visual 2", () => {
	const plan = planBubbleAttachments([img({ layout: "hero" }), img()]);
	assert.equal(plan.layout, "hero");
	assert.equal(resolveLayout([img({ layout: "hero" }), img()]), "hero");
});

test("resolveLayout: неизвестный layout → infer", () => {
	assert.equal(resolveLayout([img({ layout: "nope" }), img()]), "duo");
	assert.equal(planBubbleAttachments([img({ layout: "nope" })]).layout, "single");
});

test("resolveLayout: layout на pdf игнорируется", () => {
	assert.equal(resolveLayout([pdf({ layout: "hero" }), img(), img()]), "duo");
	assert.equal(planBubbleAttachments([pdf({ layout: "stack" }), img()]).layout, "single");
});

test("planBubbleAttachments: visual сохраняет исходный порядок", () => {
	const a = img({ name: "1" });
	const f = pdf();
	const b = vid({ name: "2" });
	const c = img({ name: "3" });
	assert.deepEqual(
		planBubbleAttachments([a, f, b, c]).visual.map((x) => x.name),
		["1", "2", "3"],
	);
});

test("truncateFileName: короткие имена без изменений, длинные — ellipsis", () => {
	assert.equal(truncateFileName("short.png"), "short.png");
	assert.equal(truncateFileName(""), "");
	assert.equal(truncateFileName(undefined), "");
	const long = "UzPRZ2iM8Bw6e7ui-extra.mp4";
	const out = truncateFileName(long, 24);
	assert.ok(out.length <= 24);
	assert.ok(out.includes("…"));
	assert.ok(out.endsWith(".mp4"));
});
