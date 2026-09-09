import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMasterSecret, opaqueDTag } from "../src/core/crypto/derivation.js";
import { FILE_SHARE_GRANT_KIND } from "../src/domain/files/share.js";

const priv = new Uint8Array(32).fill(9);
const master = deriveMasterSecret(priv);
const channelId = "11111111-1111-4111-8111-111111111111";
const readerA = "aa".repeat(32);
const readerB = "bb".repeat(32);

test("30053 d-tag уникален на (channelId, reader, version)", () => {
	const dA1 = opaqueDTag(master, 30053, `${channelId}:${readerA}:1`);
	const dB1 = opaqueDTag(master, 30053, `${channelId}:${readerB}:1`);
	const dA2 = opaqueDTag(master, 30053, `${channelId}:${readerA}:2`);
	assert.equal(dA1.length, 64);
	assert.notEqual(dA1, dB1, "два читателя одной версии не должны схлопнуться на реле");
	assert.notEqual(dA1, dA2, "ротация версии меняет d-tag");
	assert.equal(dA1, opaqueDTag(master, 30053, `${channelId}:${readerA}:1`));
});

test("30075 d-tag уникален на (nodeId, reader, version)", () => {
	const nodeId = "n-share-root";
	const dA = opaqueDTag(master, FILE_SHARE_GRANT_KIND, `${nodeId}:${readerA}:1`);
	const dB = opaqueDTag(master, FILE_SHARE_GRANT_KIND, `${nodeId}:${readerB}:1`);
	assert.notEqual(dA, dB);
	assert.notEqual(dA, opaqueDTag(master, 30053, `${nodeId}:${readerA}:1`), "другой kind даёт другой d");
});
