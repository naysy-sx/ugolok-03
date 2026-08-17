import { test } from "node:test";
import assert from "node:assert/strict";
import { createResourceOwner } from "../src/domain/media/adapters/resource-owner.js";

function ref(digest) {
	return { digest, key: null, mime: "image/jpeg", name: digest, size: 100, sourceKind: "attachment", sourceMeta: {} };
}

function fakePlaylist(digests) {
	return { items: digests.map(ref) };
}

function makeOwner() {
	const acquired = [];
	const released = [];
	const owner = createResourceOwner({
		acquire: (r) => acquired.push(r.digest),
		release: (digest) => released.push(digest),
	});
	return { owner, acquired, released };
}

test("sync: первый вызов с новыми digest'ами вызывает acquire на каждый РОВНО один раз", () => {
	const { owner, acquired } = makeOwner();
	const pl = fakePlaylist(["a", "b", "c"]);
	owner.sync(["a", "b", "c"], pl);
	assert.deepEqual(acquired, ["a", "b", "c"]);
});

test("sync: повтор digest'а в желаемом наборе (мультимножество) — acquire всё равно РОВНО один раз", () => {
	const { owner, acquired } = makeOwner();
	const pl = fakePlaylist(["a", "b"]);
	owner.sync(["a", "a", "a", "b"], pl);
	assert.deepEqual(acquired, ["a", "b"]);
});

test("sync: digest уже acquired — повторный sync с тем же набором НЕ вызывает acquire снова", () => {
	const { owner, acquired } = makeOwner();
	const pl = fakePlaylist(["a", "b"]);
	owner.sync(["a", "b"], pl);
	owner.sync(["a", "b"], pl);
	assert.deepEqual(acquired, ["a", "b"]);
});

test("sync: digest ушёл из желаемого набора — release РОВНО один раз, даже если раньше встречался с повтором", () => {
	const { owner, released } = makeOwner();
	const pl = fakePlaylist(["a", "b"]);
	owner.sync(["a", "a", "b"], pl);
	owner.sync(["b"], pl);
	assert.deepEqual(released, ["a"]);
});

test("sync: скачок между непересекающимися окнами — старые release, новые acquire", () => {
	const { owner, acquired, released } = makeOwner();
	const pl = fakePlaylist(["a", "b", "c", "d", "e", "f"]);
	owner.sync(["a", "b"], pl);
	owner.sync(["e", "f"], pl);
	assert.deepEqual(acquired, ["a", "b", "e", "f"]);
	assert.deepEqual(released, ["a", "b"]);
});

test("sync: частичное пересечение — общие digest'ы не трогаются (ни acquire, ни release повторно)", () => {
	const { owner, acquired, released } = makeOwner();
	const pl = fakePlaylist(["a", "b", "c"]);
	owner.sync(["a", "b"], pl);
	owner.sync(["b", "c"], pl);
	assert.deepEqual(acquired, ["a", "b", "c"]);
	assert.deepEqual(released, ["a"]);
});

test("releaseAll: освобождает все живые digest'ы, счётчик обнуляется", () => {
	const { owner, released } = makeOwner();
	const pl = fakePlaylist(["a", "b"]);
	owner.sync(["a", "b"], pl);
	owner.releaseAll();
	assert.deepEqual(released.sort(), ["a", "b"]);
});

test("releaseAll затем sync с тем же digest — acquire вызывается заново (счётчик действительно обнулился)", () => {
	const { owner, acquired } = makeOwner();
	const pl = fakePlaylist(["a"]);
	owner.sync(["a"], pl);
	owner.releaseAll();
	owner.sync(["a"], pl);
	assert.deepEqual(acquired, ["a", "a"]);
});

test("sync: пустой желаемый набор после непустого — release всё, acquire ничего нового", () => {
	const { owner, acquired, released } = makeOwner();
	const pl = fakePlaylist(["a", "b"]);
	owner.sync(["a", "b"], pl);
	owner.sync([], pl);
	assert.deepEqual(acquired, ["a", "b"]);
	assert.deepEqual(released, ["a", "b"]);
});
