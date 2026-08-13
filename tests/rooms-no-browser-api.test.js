// Rooms, этап 1 — DoD: "Ноль импортов браузерных API во всём каталоге —
// проверяется grep'ом в тесте" (ROOMS-SPEC.md §6, Этап 1). Чистое ядро
// (src/domain/rooms/, ПЛОСКИЕ файлы — §1.1) тестируется в node --test без
// браузера, без релея, без fake-indexeddb — использование WebSocket/DOM/
// Web Audio/Storage там означало бы, что модуль перестал быть чистым.
//
// НЕ рекурсирует в src/domain/rooms/adapters/ (§1.2, с Этапа 2) — адаптерам
// сеть/WebRTC/Web Audio разрешены контрактом, это другая категория модулей
// в той же родительской директории, не нарушение чистоты ядра.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOMS_DIR = join(import.meta.dirname, "..", "src", "domain", "rooms");

const BROWSER_API_PATTERN =
	/\bwindow\.|\bdocument\.|\bnavigator\.|\bWebSocket\b|\bRTCPeerConnection\b|\bindexedDB\b|\blocalStorage\b|\bsessionStorage\b|\bMediaRecorder\b|\bAudioContext\b|\bfetch\(/;

function listJsFilesFlat(dir) {
	const result = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) continue;
		if (entry.name.endsWith(".js")) result.push(join(dir, entry.name));
	}
	return result;
}

test("src/domain/rooms/ (чистое ядро, плоские файлы): ноль импортов/обращений к браузерным API", () => {
	const files = listJsFilesFlat(ROOMS_DIR);
	assert.ok(files.length > 0, "каталог не должен быть пуст — проверка иначе бессмысленна");
	const offenders = [];
	for (const file of files) {
		const content = readFileSync(file, "utf8");
		if (BROWSER_API_PATTERN.test(content)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `найдены обращения к браузерным API: ${offenders.join(", ")}`);
});
