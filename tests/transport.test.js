import { test } from "node:test";
import assert from "node:assert/strict";
import { createEndpointList } from "../src/core/transport/transport.js";

test("createEndpointList: current() -> первый URL сразу после создания", () => {
	const list = createEndpointList(["wss://a", "wss://b", "wss://c"]);
	assert.equal(list.current(), "wss://a");
});

test("createEndpointList: next() идёт по кругу (round-robin)", () => {
	const list = createEndpointList(["wss://a", "wss://b", "wss://c"]);
	assert.equal(list.next(), "wss://b");
	assert.equal(list.next(), "wss://c");
	assert.equal(list.next(), "wss://a");
	assert.equal(list.current(), "wss://a");
});

test("createEndpointList: reset() возвращает к первому URL", () => {
	const list = createEndpointList(["wss://a", "wss://b"]);
	list.next();
	assert.equal(list.current(), "wss://b");
	list.reset();
	assert.equal(list.current(), "wss://a");
});

test("createEndpointList: единственный endpoint — next() всегда возвращает его же", () => {
	const list = createEndpointList(["wss://only"]);
	assert.equal(list.next(), "wss://only");
	assert.equal(list.next(), "wss://only");
});

test("createEndpointList: пустой список — throw (ошибка вызывающего кода, не сетевая)", () => {
	assert.throws(() => createEndpointList([]));
});
