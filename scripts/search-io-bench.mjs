#!/usr/bin/env node
// И0 блокирующие проверки П-1/П-2 (PROCESS-DOCS/SEARCH-SYSTEM/SEARCH-SPEC.md §9)
// для этапа "Глобальный поиск". Чистый node — fake-indexeddb, реальный db-crypto.js/
// encrypted-table.js (тот же путь, что и продакшен-код), без браузера.
//
// ОГОВОРКА О ЧЕСТНОСТИ: fake-indexeddb — in-memory реализация IndexedDB API.
// Она даёт точные числа для CPU-компонентов (chacha20poly1305, JSON.parse) —
// это чистый JS, платформа не влияет. Но компонент "чтение записи из
// IndexedDB" здесь НЕ включает реальную стоимость диска/браузерного движка
// хранения — число ниже нижней границы, которую даст настоящий браузер.
// Если решение (входить в И4 или нет) окажется на грани по сумме, эту часть
// нужно перепроверить в браузере (по образцу p-spike-bench.mjs), не доверять
// голой цифре отсюда.
//
// Использование: node scripts/search-io-bench.mjs

import "fake-indexeddb/auto";
import { db } from "../src/core/store/database.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MESSAGES_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { encryptRow, decryptRow } from "../src/core/crypto/db-crypto.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const N = 10000;
const dbKey = crypto.getRandomValues(new Uint8Array(32));

function randomText(len) {
	const alphabet = "абвгдежзийклмнопрстуфхцчшщъыьэюя ";
	let s = "";
	for (let i = 0; i < len; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
	return s;
}

function median(arr) {
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

async function populate() {
	console.log(`Заполняю messages: ${N} строк текущего владельца + 2000 чужих (другой owner, для П-1)...`);
	const rows = [];
	for (let i = 0; i < N; i++) {
		rows.push(
			toEncryptedRow(
				{
					ownerPubkey: OWNER,
					chatId: `chat-${i % 50}`,
					msgId: `m-${i}`,
					lamportTs: i,
					senderPubkey: OWNER,
					id: `id-${i}`,
					status: "sent",
					deleted: false,
					text: randomText(150 + ((i * 37) % 250)),
				},
				MESSAGES_PLAINTEXT_FIELDS,
				dbKey,
			),
		);
	}
	// Чужие сообщения перемежаются по seq (другой owner на том же устройстве,
	// П-1: проверка, что фильтр по ownerPubkey не путается с "полным проходом").
	for (let i = 0; i < 2000; i++) {
		rows.splice((i * 6) % rows.length, 0, toEncryptedRow(
			{ ownerPubkey: OTHER_OWNER, chatId: `chat-${i}`, msgId: `o-${i}`, lamportTs: i, senderPubkey: OTHER_OWNER, id: `oid-${i}`, status: "sent", deleted: false, text: randomText(200) },
			MESSAGES_PLAINTEXT_FIELDS,
			dbKey,
		));
	}
	await db.table("messages").bulkAdd(rows);
	console.log(`  всего строк в таблице: ${await db.table("messages").count()}`);
}

async function checkP1() {
	console.log("\n=== П-1: обратный обход messages по seq, фильтр по ownerPubkey ===");
	const seqSeen = [];
	const t0 = performance.now();
	let scanned = 0;
	let matched = 0;
	await db.table("messages").toCollection().reverse().each((row) => {
		scanned++;
		seqSeen.push(row.seq);
		if (row.ownerPubkey === OWNER) matched++;
	});
	const elapsed = performance.now() - t0;

	let monotonicDesc = true;
	for (let i = 1; i < seqSeen.length; i++) {
		if (seqSeen[i] > seqSeen[i - 1]) { monotonicDesc = false; break; }
	}

	console.log(`  строк просканировано (все owner'ы): ${scanned}, из них текущего owner: ${matched}`);
	console.log(`  seq строго не возрастает на всём проходе: ${monotonicDesc ? "ДА (курсор идёт от больших к меньшим)" : "НЕТ — сортировки после выборки быть не должно, это провал проверки"}`);
	console.log(`  полный обратный проход (${scanned} строк, без ранней остановки): ${elapsed.toFixed(1)} мс`);

	// Досрочное прекращение: сколько строк реально нужно прочитать, чтобы
	// набрать k=100 совпадений текущего owner'а.
	const k = 100;
	let earlyScanned = 0;
	let earlyMatched = 0;
	const tEarly0 = performance.now();
	await db.table("messages").toCollection().reverse().until((row) => earlyMatched >= k).each((row) => {
		earlyScanned++;
		if (row.ownerPubkey === OWNER) earlyMatched++;
	});
	const tEarly = performance.now() - tEarly0;
	console.log(`  досрочное прекращение (k=${k}): прочитано ${earlyScanned} строк за ${tEarly.toFixed(1)} мс (вместо ${scanned} строк / ${elapsed.toFixed(1)} мс)`);
	console.log(`  ВЫВОД: экономия от раннего обрыва пропорциональна ДОЛЕ СВОЕГО owner'а в общем количестве строк устройства, а не общему числу сообщений одного owner'а — при нескольких аккаунтах на одном устройстве курсор всё равно читает (не расшифровывает) чужие строки.`);
}

async function checkP2() {
	console.log("\n=== П-2: стоимость одной строки, три компонента раздельно ===");
	const rawRows = await db.table("messages").where("ownerPubkey").equals(OWNER).limit(2000).toArray();
	console.log(`  выборка для замера: ${rawRows.length} строк уже прочитанных из fake-indexeddb`);

	// (a) чтение из IndexedDB — повторный .get() по известным ключам, отдельно от расшифровки.
	const seqs = rawRows.map((r) => r.seq);
	const tReadStart = performance.now();
	for (const seq of seqs) await db.table("messages").get(seq);
	const tRead = performance.now() - tReadStart;

	// (b) chacha20poly1305 расшифровка ОТДЕЛЬНО от JSON.parse.
	const tDecryptStart = performance.now();
	const plaintexts = [];
	for (const row of rawRows) {
		const pt = chacha20poly1305(dbKey, row.nonce).decrypt(row.ciphertext);
		plaintexts.push(pt);
	}
	const tDecrypt = performance.now() - tDecryptStart;

	// (c) JSON.parse С ревайвером (реальный путь) и БЕЗ (гипотеза §4 ALGO).
	function reviver(key, value) {
		if (value && typeof value === "object" && typeof value.__u8__ === "string") {
			return Uint8Array.from(atob(value.__u8__), (c) => c.charCodeAt(0));
		}
		return value;
	}
	const texts = plaintexts.map((pt) => new TextDecoder().decode(pt));

	const tParseReviverStart = performance.now();
	for (const t of texts) JSON.parse(t, reviver);
	const tParseReviver = performance.now() - tParseReviverStart;

	const tParsePlainStart = performance.now();
	for (const t of texts) JSON.parse(t);
	const tParsePlain = performance.now() - tParsePlainStart;

	const n = rawRows.length;
	console.log(`  (a) чтение из хранилища (fake-indexeddb, .get() ×${n}): ${tRead.toFixed(1)} мс — ${(tRead / n).toFixed(4)} мс/строка [НИЖНЯЯ ГРАНИЦА, см. оговорку в шапке файла]`);
	console.log(`  (b) chacha20poly1305 расшифровка ×${n}: ${tDecrypt.toFixed(1)} мс — ${(tDecrypt / n).toFixed(4)} мс/строка`);
	console.log(`  (c) JSON.parse С ревайвером ×${n}: ${tParseReviver.toFixed(1)} мс — ${(tParseReviver / n).toFixed(4)} мс/строка`);
	console.log(`  (c') JSON.parse БЕЗ ревайвера ×${n}: ${tParsePlain.toFixed(1)} мс — ${(tParsePlain / n).toFixed(4)} мс/строка`);
	const ratio = tParseReviver / tParsePlain;
	console.log(`  ревайвер дороже парсинга без него в ${ratio.toFixed(2)}× раз`);
	console.log(`  ревайвер / расшифровка: ${(tParseReviver / tDecrypt).toFixed(2)}×`);
}

async function main() {
	await populate();
	await checkP1();
	await checkP2();
	await db.delete();
}

main().catch((e) => {
	console.error("search-io-bench: ошибка", e);
	process.exitCode = 1;
});
