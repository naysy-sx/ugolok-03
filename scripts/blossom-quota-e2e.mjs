#!/usr/bin/env node
// Сквозная приёмка квот (ТЗ-04): настоящие клиентские функции против настоящего сервера.
//   node scripts/blossom-quota-e2e.mjs enabled  <url> <контейнер>   сервер: default_bytes=1000000, max_file_bytes=600000
//   node scripts/blossom-quota-e2e.mjs disabled <url>               сервер с quota.enabled=false, max_upload_size_bytes=3000000
// Запускает scripts/blossom-quota-acceptance.sh (поднимает контейнеры сам).
import { execSync } from "node:child_process";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { fetchQuota, uploadBlob } from "../src/core/transport/blossom-client.js";
import { putStream } from "../src/domain/files/content.js";
import { fetchServerBlobs, freeBlobs } from "../src/domain/uploads/storage.js";
import { normalizeQuota, checkBatch } from "../src/domain/uploads/quota.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { errorMessage, setLocale } from "../src/ui/signals/i18n.js";

setLocale("ru");
const [mode, url, container] = process.argv.slice(2);
const newKey = () => {
	const priv = crypto.getRandomValues(new Uint8Array(32));
	return { priv, pub: bytesToHex(getPublicKey(priv)) };
};
const bytes = (n) => {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i += 65536) b.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, n - i))), i);
	return b;
};
let fails = 0;
const ok = (name, cond, extra = "") => {
	console.log((cond ? "ok   " : "FAIL ") + name + (extra ? " — " + extra : ""));
	if (!cond) fails++;
};
const put = (data, key, name = "f.bin") => putStream(data, { name, mime: "application/octet-stream", serverUrl: url, privateKey: key.priv });

if (mode === "enabled") {
	const A = newKey();
	const B = newKey();
	let q = normalizeQuota(await fetchQuota(url, A.priv));
	ok("GET /api/quota подписью клиента", q?.enabled && q.limit === 1000000 && q.used === 0 && q.maxFileSize === 600000 && q.mode === "normal", JSON.stringify(q));

	await put(bytes(300000), A);
	q = normalizeQuota(await fetchQuota(url, A.priv));
	ok("после заливки used вырос", q.used > 300000 && q.used < 302000, "used=" + q.used);

	await put(bytes(590000), A, "второй.bin");
	let refused;
	try {
		await put(bytes(200000), A, "третий.bin");
	} catch (e) {
		refused = e;
	}
	ok("сверх остатка — понятная ошибка квоты (до PUT)", refused?.key === "errors.quotaExceeded", refused?.key + " | " + (refused && errorMessage(refused)));

	let big;
	try {
		await put(bytes(700000), B, "огромный.bin");
	} catch (e) {
		big = e;
	}
	ok("крупнее предела файла — file-too-large", big?.key === "errors.fileTooLargeForServer", big?.key + " | " + (big && errorMessage(big)));
	ok("checkBatch по данным сервера совпадает с сервером", checkBatch([{ name: "x.pdf", size: 700000, mime: "application/pdf" }], normalizeQuota(await fetchQuota(url, B.priv))).reason === "file-too-large");

	const body = bytes(650000);
	let direct;
	try {
		await uploadBlob(url, body, bytesToHex(sha256(body)), B.priv, {});
	} catch (e) {
		direct = e;
	}
	ok("PUT сверх предела: BlossomRefusal(file-too-large)", direct?.name === "BlossomRefusal" && direct.reason === "file-too-large", direct?.reason);

	const anon = await fetch(`${url}/list/${A.pub}`);
	ok("/list без подписи -> 401", anon.status === 401, "status " + anon.status);
	let foreign;
	try {
		await fetchServerBlobs(url, A.pub, { privateKey: B.priv });
	} catch (e) {
		foreign = e;
	}
	ok("/list чужой подписью -> 403", foreign?.status === 403, "status " + foreign?.status);
	const mine = await fetchServerBlobs(url, A.pub, { privateKey: A.priv });
	ok("/list своей подписью: блобы двух файлов (контент+манифест)", mine.length === 4, "blobs=" + mine.length);

	const freed = await freeBlobs({ serverUrl: url, privateKey: A.priv, hashes: mine.map((b) => b.hash) });
	q = normalizeQuota(await fetchQuota(url, A.priv));
	ok("после освобождения used = 0", freed.deleted.length === 4 && q.used === 0, JSON.stringify(freed.failed));

	// quota-set: клиент видит новое значение при перезапросе (на Linux-хосте; на macOS bind-mount иногда запаздывает)
	if (container) {
		const C = newKey();
		await fetchQuota(url, C.priv);
		execSync(`docker exec ${container} /app/quota-set ${C.pub} 50MB --note "тест"`, { stdio: "pipe" });
		q = normalizeQuota(await fetchQuota(url, C.priv));
		ok("после quota-set клиент видит новый потолок", q.limit === 50 * 1024 * 1024, "limit=" + q.limit);
	}
} else {
	const K = newKey();
	const q = normalizeQuota(await fetchQuota(url, K.priv));
	ok("enabled:false — /api/quota говорит «без ограничений», предел файла из max_upload_size", q.enabled === false && q.limit === null && q.maxFileSize === 3000000, JSON.stringify(q));
	await put(bytes(2500000), K);
	ok("заливка 2,5 МБ (больше бесплатного 1 МБ) проходит как раньше", true);
	const open = await fetch(`${url}/list/${K.pub}`);
	ok("/list открыт без подписи, как до квот", open.status === 200, "status " + open.status);
	const signed = await fetchServerBlobs(url, K.pub, { privateKey: K.priv });
	ok("с подписью тоже работает (обратная совместимость)", signed.length === 2);
}
console.log(fails ? `\n${fails} проверок не прошло` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
