import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	getMemoryCachedUrl,
	putMemoryCachedAttachment,
	evictMemoryCacheIfNeeded,
	clearMemoryCache,
} from "../src/ui/attachment-memory-cache.js";

beforeEach(() => {
	clearMemoryCache();
});

test("putMemoryCachedAttachment + getMemoryCachedUrl: промах -> undefined, попадание -> тот же url", () => {
	assert.equal(getMemoryCachedUrl("nope"), undefined);
	const url = putMemoryCachedAttachment("s1", new Uint8Array([1, 2, 3]), "image/png");
	assert.equal(typeof url, "string");
	assert.equal(getMemoryCachedUrl("s1"), url);
});

test("putMemoryCachedAttachment: повторный put того же sha256 возвращает СУЩЕСТВУЮЩИЙ url, не плодит новый Blob", () => {
	const url1 = putMemoryCachedAttachment("s1", new Uint8Array([1, 2, 3]), "image/png");
	const url2 = putMemoryCachedAttachment("s1", new Uint8Array([9, 9, 9]), "image/png");
	assert.equal(url1, url2);
});

test("evictMemoryCacheIfNeeded: превышение бюджета вытесняет САМЫЕ СТАРЫЕ (порядок вставки) первыми", () => {
	putMemoryCachedAttachment("s1", new Uint8Array(40), "image/png");
	putMemoryCachedAttachment("s2", new Uint8Array(40), "image/png");
	putMemoryCachedAttachment("s3", new Uint8Array(40), "image/png");

	evictMemoryCacheIfNeeded({ budgetBytes: 90 }); // 120 > 90 -> одна запись должна уйти

	assert.equal(getMemoryCachedUrl("s1"), undefined, "самая старая (s1) вытесняется первой");
	assert.notEqual(getMemoryCachedUrl("s2"), undefined);
	assert.notEqual(getMemoryCachedUrl("s3"), undefined);
});

test("getMemoryCachedUrl: обращение переставляет запись в MRU-конец — защищает от следующего вытеснения", () => {
	putMemoryCachedAttachment("s1", new Uint8Array(40), "image/png");
	putMemoryCachedAttachment("s2", new Uint8Array(40), "image/png");

	getMemoryCachedUrl("s1"); // s1 теперь MRU, s2 — LRU

	putMemoryCachedAttachment("s3", new Uint8Array(40), "image/png"); // 120 > budget 90 ниже
	evictMemoryCacheIfNeeded({ budgetBytes: 90 });

	assert.equal(getMemoryCachedUrl("s2"), undefined, "s2 теперь самая старая — вытесняется");
	assert.notEqual(getMemoryCachedUrl("s1"), undefined, "s1 пережила вытеснение благодаря обращению");
});

test("clearMemoryCache: опустошает кэш полностью", () => {
	putMemoryCachedAttachment("s1", new Uint8Array([1]), "image/png");
	putMemoryCachedAttachment("s2", new Uint8Array([2]), "image/png");
	clearMemoryCache();
	assert.equal(getMemoryCachedUrl("s1"), undefined);
	assert.equal(getMemoryCachedUrl("s2"), undefined);
});

test("putMemoryCachedAttachment: одна запись больше бюджета сама по себе — не падает, самовытесняется", () => {
	const url = putMemoryCachedAttachment("huge", new Uint8Array(120), "video/mp4", { budgetBytes: 90 });
	assert.equal(typeof url, "string", "url всё равно создаётся (Blob создан, просто сразу же вытесняется)");
	assert.equal(getMemoryCachedUrl("huge"), undefined);
});
