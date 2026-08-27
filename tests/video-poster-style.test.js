import { test } from "node:test";
import assert from "node:assert/strict";
import { videoPosterUrl, videoPosterStyle } from "../src/ui/components/video-poster-style.js";

test("videoPosterUrl: data:image и blob принимаются", () => {
	assert.equal(videoPosterUrl("data:image/jpeg;base64,aaaa"), "data:image/jpeg;base64,aaaa");
	assert.equal(videoPosterUrl("blob:http://localhost/abc-def"), "blob:http://localhost/abc-def");
});

test("videoPosterUrl: http/https/мусор — null (сеть в пузыре запрещена)", () => {
	assert.equal(videoPosterUrl("https://example.com/a.jpg"), null);
	assert.equal(videoPosterUrl("http://127.0.0.1/a.jpg"), null);
	assert.equal(videoPosterUrl(""), null);
	assert.equal(videoPosterUrl(null), null);
	assert.equal(videoPosterUrl("not-a-url"), null);
	assert.equal(videoPosterUrl("data:text/plain,hi"), null);
});

test("videoPosterStyle: cover + position + quoted url", () => {
	const style = videoPosterStyle("data:image/jpeg;base64,xx");
	assert.equal(style.backgroundImage, 'url("data:image/jpeg;base64,xx")');
	assert.equal(style.backgroundSize, "cover");
	assert.equal(style.backgroundPosition, "center");
	assert.equal(style.backgroundRepeat, "no-repeat");
});

test("videoPosterStyle: пустой постер → undefined", () => {
	assert.equal(videoPosterStyle(undefined), undefined);
	assert.equal(videoPosterStyle(""), undefined);
});
