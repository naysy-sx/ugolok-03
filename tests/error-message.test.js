import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage, setLocale } from "../src/ui/signals/i18n.js";

test("404 от Blossom при чтении даёт понятное сообщение, а не сырой текст", () => {
	setLocale("ru");
	const gone = "Файл больше недоступен на сервере (возможно, его освободили с сервера).";
	assert.equal(errorMessage(new Error("Blossom download failed: 404")), gone);
	const range = Object.assign(new Error("Blossom Range GET не поддержан (ожидался 206, получен 404) для abc"), { status: 404 });
	assert.equal(errorMessage(range), gone);
});

test("прочие ошибки не подменяются", () => {
	setLocale("ru");
	assert.equal(errorMessage(new Error("Blossom download failed: 500")), "Blossom download failed: 500");
	assert.equal(errorMessage(new Error("что-то другое 404")), "что-то другое 404");
	assert.equal(errorMessage({ key: "common.cancel" }), "Отмена");
});
