import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CHANNEL_UNVIEW_KIND } from "../src/domain/content/channel-access.js";
import { KIND_FILES_OP, KIND_FILES_OP_LEGACY } from "../src/domain/files/sync.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("files-op пишет 3011; 3007 остаётся только unview rumor и legacy-чтением", () => {
	assert.equal(CHANNEL_UNVIEW_KIND, 3007);
	assert.equal(KIND_FILES_OP_LEGACY, 3007);
	assert.equal(KIND_FILES_OP, 3011);
	assert.notEqual(KIND_FILES_OP, CHANNEL_UNVIEW_KIND);
});

test("ни одна REQ-подписка не берёт kinds:[3007] как regular-событие", () => {
	const transport = readFileSync(join(root, "src/ui/signals/transport.js"), "utf8");
	const kindsFilters = [...transport.matchAll(/kinds:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
	for (const inner of kindsFilters) {
		const nums = inner.split(",").map((s) => s.trim());
		const has3007Literal = nums.includes("3007");
		const hasUnviewConst = nums.some((s) => s.includes("CHANNEL_UNVIEW_KIND"));
		const hasFilesConst = nums.some((s) => s.includes("KIND_FILES_OP"));
		assert.equal(has3007Literal, false, `подписка kinds:[${inner}] не должна содержать литерал 3007`);
		assert.equal(hasUnviewConst, false, "unview — rumor внутри 1059, не фильтр kinds");
		assert.equal(hasFilesConst, false, "files op читается из events-таблицы, не живой kinds-фильтр");
	}
});

test("gift-wrap диспетчер сравнивает rumor.kind с CHANNEL_UNVIEW_KIND, не кладёт rumor в events как kind 3007", () => {
	const transport = readFileSync(join(root, "src/ui/signals/transport.js"), "utf8");
	assert.match(transport, /rumor\.kind === CHANNEL_UNVIEW_KIND/);
	assert.match(transport, /applyChannelUnviewRumor/);
	const unviewBlock = transport.slice(transport.indexOf("rumor.kind === CHANNEL_UNVIEW_KIND"));
	const block = unviewBlock.slice(0, unviewBlock.indexOf("} else if"));
	assert.equal(block.includes("appendEvent"), false);
	assert.equal(block.includes('table("events")'), false);
});

test("журнал файлов читает и 3011, и legacy 3007", () => {
	const files = readFileSync(join(root, "src/ui/signals/files.js"), "utf8");
	assert.match(files, /KIND_FILES_OP_LEGACY/);
	assert.match(files, /KIND_FILES_OP/);
	assert.match(files, /equals\(\[ownerPubkey, KIND_FILES_OP\]\)/);
	assert.match(files, /equals\(\[ownerPubkey, KIND_FILES_OP_LEGACY\]\)/);
});
