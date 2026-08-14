// Rooms, этап 1 — DoD: "Ноль импортов браузерных API во всём каталоге —
// проверяется grep'ом в тесте" (ROOMS-SPEC.md §6, Этап 1). Чистое ядро
// тестируется в node --test без браузера, без релея, без fake-indexeddb —
// использование WebSocket/DOM/Web Audio/Storage там означало бы, что модуль
// перестал быть чистым.
//
// ЯВНЫЙ список — ROOMS-SPEC §1.1's семь модулей буквально, НЕ "все плоские
// файлы каталога". Найдено на Этапе 4: room-session.js тоже лежит плоско в
// src/domain/rooms/ (файловая организация спеки, не про чистоту), но это
// "Оркестратор" (§1.3) — ДРУГАЯ категория, ему контрактно положено знать про
// адаптеры и (с Этапа 4) про navigator.mediaDevices.getUserMedia по
// умолчанию. Проверка по имени файла, а не по позиции в дереве, переживёт
// будущие файлы уровня оркестратора, не обвиняя их ложно.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOMS_DIR = join(import.meta.dirname, "..", "src", "domain", "rooms");

// ROOMS-SPEC.md §1.1 — ровно эти семь.
const PURE_CORE_FILES = ["room-keys.js", "presence.js", "room-machine.js", "trickle.js", "mesh.js", "message-log.js", "room-events.js"];

const BROWSER_API_PATTERN =
	/\bwindow\.|\bdocument\.|\bnavigator\.|\bWebSocket\b|\bRTCPeerConnection\b|\bindexedDB\b|\blocalStorage\b|\bsessionStorage\b|\bMediaRecorder\b|\bAudioContext\b|\bfetch\(/;

test("src/domain/rooms/: семь модулей чистого ядра (ROOMS-SPEC §1.1) — ноль импортов/обращений к браузерным API", () => {
	const offenders = [];
	for (const name of PURE_CORE_FILES) {
		const content = readFileSync(join(ROOMS_DIR, name), "utf8");
		if (BROWSER_API_PATTERN.test(content)) offenders.push(name);
	}
	assert.deepEqual(offenders, [], `найдены обращения к браузерным API: ${offenders.join(", ")}`);
});
