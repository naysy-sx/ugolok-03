// Э2.1 ТЗ-NATIVE-APPS — «в пределах лимита: расшифровать файл существующим
// конвейером (очередь загрузки, чанки, воркер) в Blob → URL.createObjectURL».
// Этот конвейер уже есть: decryptWholeFileToBlobUrl (media-url.js) — тот же
// путь, что раньше был фолбэком для старого мобильного Safari без
// SW-controller (MEDIA-PERF-TZ.md §6.3), полностью декодирует файл через
// getManifest/getRange. Вызывается НАПРЯМУЮ, не через acquireMediaUrl —
// acquireMediaUrl САМА делегирует сюда через getPlatform().media.getPlayableSource
// (см. media-url.js), поэтому вызов в обратную сторону создал бы цикл.
//
// Blob/URL.createObjectURL — обычный веб-API, работает в ЛЮБОМ WebView
// (Capacitor Android/iOS, Tauri WebView2/WebKitGTK) без единого нативного SDK —
// поэтому этот файл НЕ импортирует @capacitor/*/@tauri-apps/* и общий и для
// capacitor.js, и для tauri.js (§4.2 ограничивает только native SDK импорты).
import { decryptWholeFileToBlobUrl } from "../domain/media/adapters/media-url.js";

// Э2.1 — «Лимиты по умолчанию: desktop 1 ГиБ, Android 256 МБ, iOS 150 МБ».
// T11 (E0-REPORT.md) проверил живьём блобы 200/500 МиБ на всех пяти средах,
// включая Android-эмулятор с 2.5 ГБ RAM — ни одного ООМ; эти лимиты по ТЗ
// остаются консервативным запасом, T11 их не опровергает.
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

export function mediaSizeLimitBytes(shell, os) {
	if (shell === "tauri") return GIB; // desktop — одинаково для Windows/macOS/Linux
	if (os === "ios") return 150 * MIB;
	return 256 * MIB; // android — дефолт для capacitor
}

export function exceedsMediaSizeLimit(shell, os, size) {
	if (typeof size !== "number") return false; // размер неизвестен — не блокируем вслепую
	return size > mediaSizeLimitBytes(shell, os);
}

// Р2.2 — файл больше лимита: владелец выбрал (А) «расшифровать во временный
// файл и играть с диска» (2026-09-27, отклонение от дефолта ТЗ (Б) — см.
// PROGRESS.md). Сама запись на диск нужна через @capacitor/filesystem или
// @tauri-apps/plugin-fs — настоящих native-проектов ещё нет (Э3/Э4), проверить
// это без реальной нативной оболочки невозможно. Оставлено как throw с чёткой
// причиной (см. capacitor.js/tauri.js) — не реализовано вслепую.

// decrypt — DI по тому же принципу, что MediaRecorderImpl/WebSocketImpl по
// всей кодовой базе (тесты подставляют фейк, не трогая реальную сеть/манифесты).
// serverUrl/fetchImpl не входят в контракт §4.3 (getPlayableSource(fileRef,
// {mime, size, onProgress})) — media-url.js's acquireMediaUrl прокидывает их
// сверх контракта, чтобы decryptWholeFileToBlobUrl достучался до того же
// сервера/fetchImpl, что и остальной конвейер (и чтобы тесты могли подменить
// сеть); лишний ключ в опциях безвреден для всего, что его не ждёт.
export async function getPlayableSourceUnderLimit(fileRef, { onProgress, decrypt = decryptWholeFileToBlobUrl, ...rest } = {}) {
	const url = await decrypt(fileRef, { onProgress, ...rest });
	return {
		url,
		release: () => {
			URL.revokeObjectURL(url);
		},
	};
}
