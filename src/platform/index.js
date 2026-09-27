// Э1.2/§4.3 ТЗ-NATIVE-APPS — единственная точка, через которую остальной код
// узнаёт о платформе. Контракт целиком — README.md рядом с этим файлом.
//
// if (__TARGET__ === '…') статический, не динамический — __TARGET__ подставляется
// Vite'ом (define в vite.config.js) буквальной строкой на этапе сборки, поэтому
// Rollup вырезает недостижимые ветки целиком: импорт capacitor.js/tauri.js (а с
// ним и БУДУЩИЕ @capacitor/*/@tauri-apps/* импорты внутри них) не попадает в
// веб-бандл. §4.2 — проверка: grep по dist/index.html не находит "Capacitor"/
// "__TAURI".
import { createPlatform as createWebPlatform } from "./web.js";
import { createPlatform as createCapacitorPlatform } from "./capacitor.js";
import { createPlatform as createTauriPlatform } from "./tauri.js";

let instance = null;

// typeof-guard ПРЯМО в условии (тот же приём, что src/config.js's BUILD_HASH,
// НЕ вынесенный в отдельную функцию — вынесение в helper проверено эмпирически:
// ломает вырезание недостижимой ветки Rolldown'ом, потому что define-подстановка
// __TARGET__ видит только литерал в условии, а не аргумент вызова функции, куда
// он передан). Под `node --test` нет Vite `define`, "__TARGET__" не объявлен
// вовсе — typeof на необъявленном идентификаторе не бросает, голое сравнение
// без typeof бросило бы ReferenceError.
export function getPlatform() {
	if (instance) return instance;
	if (typeof __TARGET__ !== "undefined" && __TARGET__ === "capacitor") instance = createCapacitorPlatform();
	else if (typeof __TARGET__ !== "undefined" && __TARGET__ === "tauri") instance = createTauriPlatform();
	else instance = createWebPlatform();
	return instance;
}

// Э1.6 — тестам нужен способ сбросить синглтон между прогонами (модуль
// импортируется один раз на процесс node --test, иначе первый вызвавший тест
// getPlatform() навсегда зафиксировал бы инстанс для всех остальных).
export function resetPlatformForTests() {
	instance = null;
}
