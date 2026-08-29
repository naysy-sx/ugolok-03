import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Метка сборки для версионирования cache (F-OF-06: ugolok-cache-v{BUILD_HASH}).
// ВАЖНО: это НЕ хеш содержимого index.html для NF-18 — тот считается ПОСТ-сборки
// в scripts/release-hash.sh. Здесь — build-time идентификатор, не content-hash.
const BUILD_HASH =
    process.env.BUILD_HASH ??
    (() => {
        try {
            return execSync("git rev-parse --short HEAD").toString().trim();
        } catch {
            return "dev";
        }
    })();

// Поднимает локальный strfry (server/strfry/) вместе с `vite dev`, чтобы
// диагностика всегда имела живой relay, а не таймаутила на "disconnected"
// без ручного запуска run.sh отдельным терминалом. apply:"serve" — на
// build/preview не действует, дефолт-relay продакшн-сборки не трогает.
function devRelayPlugin() {
    const strfryBinary = fileURLToPath(
        new URL("./server/strfry/strfry-src/strfry", import.meta.url),
    );
    const dbDir = fileURLToPath(
        new URL("./server/strfry/strfry-db", import.meta.url),
    );
    const runScript = fileURLToPath(
        new URL("./server/strfry/run.sh", import.meta.url),
    );
    let child;
    return {
        name: "ugolok:dev-relay",
        apply: "serve",
        configureServer(server) {
            if (!existsSync(strfryBinary)) {
                server.config.logger.warn(
                    "[ugolok:dev-relay] strfry не собран (см. server/README.md) — диагностика останется без живого relay.",
                );
                return;
            }
            if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

            child = spawn(runScript, [], { stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", (d) =>
                process.stdout.write(`[strfry] ${d}`),
            );
            child.stderr.on("data", (d) =>
                process.stderr.write(`[strfry] ${d}`),
            );
            child.on("exit", (code, signal) => {
                if (code !== 0 && signal !== "SIGTERM") {
                    // Частая причина — порт 7777 уже занят другим strfry (запущен вручную
                    // или другим `vite dev`); не роняем dev-сервер из-за этого.
                    // code=134 / dyld «Library not loaded» — Homebrew обновил secp256k1
                    // (или lmdb/libuv): бинарник собран против старого .dylib.
                    // Лечится `server/strfry/setup.sh` (теперь делает make, не skip).
                    server.config.logger.warn(
                        `[ugolok:dev-relay] strfry завершился (code=${code}). Если dyld «Library not loaded» — server/strfry/setup.sh.`,
                    );
                }
            });
            const stop = () => {
                if (child && !child.killed) child.kill();
            };
            process.once("exit", stop);
            server.httpServer?.once("close", stop);
        },
    };
}

// Этап 28, довесок — тот же принцип, что devRelayPlugin выше, для тестового
// Blossom-сервера (server/blossom/). Отдельная функция, не параметризация общей —
// разные бинарники/пути/готовностные проверки, дублирование проще читать, чем
// разбирать общий helper с двумя режимами.
function devBlossomPlugin() {
    const blossomBinary = fileURLToPath(
        new URL("./server/blossom/blossom-src/bin/app", import.meta.url),
    );
    const dbDir = fileURLToPath(
        new URL("./server/blossom/blossom-db", import.meta.url),
    );
    const runScript = fileURLToPath(
        new URL("./server/blossom/run.sh", import.meta.url),
    );
    let child;
    return {
        name: "ugolok:dev-blossom",
        apply: "serve",
        configureServer(server) {
            if (!existsSync(blossomBinary)) {
                server.config.logger.warn(
                    "[ugolok:dev-blossom] Blossom-сервер не собран (см. server/README.md) — вложения останутся без живого сервера.",
                );
                return;
            }
            if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

            child = spawn(runScript, [], { stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", (d) =>
                process.stdout.write(`[blossom] ${d}`),
            );
            child.stderr.on("data", (d) =>
                process.stderr.write(`[blossom] ${d}`),
            );
            child.on("exit", (code, signal) => {
                if (code !== 0 && signal !== "SIGTERM") {
                    // Частая причина — порт 8080 уже занят другим blossom (запущен вручную
                    // или другим `vite dev`); не роняем dev-сервер из-за этого.
                    server.config.logger.warn(
                        `[ugolok:dev-blossom] blossom завершился (code=${code}).`,
                    );
                }
            });
            const stop = () => {
                if (child && !child.killed) child.kill();
            };
            process.once("exit", stop);
            server.httpServer?.once("close", stop);
        },
    };
}

function devTurnPlugin() {
    const runScript = fileURLToPath(
        new URL("./server/coturn/run.sh", import.meta.url),
    );
    let child;
    return {
        name: "ugolok:dev-turn",
        apply: "serve",
        configureServer(server) {
            if (!existsSync(runScript)) {
                server.config.logger.warn(
                    "[ugolok:dev-turn] coturn не установлен (см. server/README.md) — ICE останется без локального TURN.",
                );
                return;
            }

            child = spawn(runScript, [], { stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", (d) =>
                process.stdout.write(`[coturn] ${d}`),
            );
            child.stderr.on("data", (d) =>
                process.stderr.write(`[coturn] ${d}`),
            );
            child.on("exit", (code, signal) => {
                if (code !== 0 && signal !== "SIGTERM") {
                    server.config.logger.warn(
                        `[ugolok:dev-turn] coturn завершился (code=${code}).`,
                    );
                }
            });
            const stop = () => {
                if (child && !child.killed) child.kill();
            };
            process.once("exit", stop);
            server.httpServer?.once("close", stop);
        },
    };
}

// Дефолт локального острова (localhost) для serve и build: локальный strfry.
// Настоящий деплой обязан переопределить через BUILD_DEFAULT_RELAYS.
function buildDefaultRelays() {
    if (process.env.BUILD_DEFAULT_RELAYS)
        return JSON.parse(process.env.BUILD_DEFAULT_RELAYS);
    return ["ws://127.0.0.1:7777"];
}

// Этап 61 — отдельная env-ручка на будущее (когда bootstrap-координатор
// ugolok.tech разойдётся с собственным relay пользователя). Сегодня это
// физически один сервер — дефолт совпадает с buildDefaultRelays.
// Настоящий деплой — через BUILD_BOOTSTRAP_RELAYS.
function buildBootstrapRelays() {
    if (process.env.BUILD_BOOTSTRAP_RELAYS)
        return JSON.parse(process.env.BUILD_BOOTSTRAP_RELAYS);
    return buildDefaultRelays();
}

// Дефолт локального острова (localhost) для serve и build: server/blossom/.
// Настоящий деплой обязан переопределить через BUILD_DEFAULT_BLOSSOM_SERVERS.
function buildDefaultBlossomServers() {
    if (process.env.BUILD_DEFAULT_BLOSSOM_SERVERS)
        return JSON.parse(process.env.BUILD_DEFAULT_BLOSSOM_SERVERS);
    return ["http://127.0.0.1:8080"];
}

// Дефолт локального острова (localhost) для serve и build: свой STUN/TURN
// первым, Google STUN как fallback. Настоящий деплой обязан переопределить
// через BUILD_DEFAULT_ICE_SERVERS, добавив свой coturn ПЕРВЫМ.
function buildDefaultIceServers() {
    if (process.env.BUILD_DEFAULT_ICE_SERVERS)
        return JSON.parse(process.env.BUILD_DEFAULT_ICE_SERVERS);
    return [
        { urls: "stun:127.0.0.1:3478" },
        {
            urls: "turn:127.0.0.1:3478",
            username: "ugolok",
            credential: "ugolok-dev",
        },
        { urls: "stun:stun.l.google.com:19302" },
    ];
}

// CONTRACTS.md §DISCOVERY, T9 — пустая строка по умолчанию: self-hosted
// инстанс без назначенного админа не должен показывать нерабочую кнопку
// "Пожаловаться" (VisibilitySection/discovery.jsx проверяет непустоту).
function buildAdminPubkey() {
    return process.env.BUILD_ADMIN_PUBKEY ?? "";
}

// Этап E, найдено живой проверкой пользователя — в dev SW вообще не
// регистрировался (main.jsx: `if (!import.meta.env.DEV)`), поэтому
// /files-content/* улетал в SPA-фолбэк index.html (text/html), и mp3/mp4
// молча не играли ни разу за всю сессию. emitServiceWorker (ниже) — плагин
// СБОРКИ (apply:"build", generateBundle — Vite dev его не зовёт вовсе), так
// что для `vite dev` нужен отдельный путь раздачи. __BUILD_HASH__ здесь
// подставляется буквальной строкой "dev" — service-worker.js's IS_DEV на
// это ориентируется, чтобы выключить precache/cache-first статики (иначе
// сломал бы HMR — кэш отдавал бы старый код после правки файла); files-
// content:range-* остаётся активным что в dev, что в проде.
function devServiceWorkerPlugin() {
    return {
        name: "ugolok:dev-service-worker",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url !== "/service-worker.js") return next();
                const src = readFileSync(
                    "service-worker.js",
                    "utf8",
                ).replaceAll("__BUILD_HASH__", () => "dev");
                res.setHeader(
                    "Content-Type",
                    "application/javascript; charset=utf-8",
                );
                res.setHeader("Service-Worker-Allowed", "/");
                res.end(src);
            });
        },
    };
}

// SW не должен инлайниться в index.html, но БАНДЛИТЬ define-константы — должен.
// Эмитим его отдельным ассетом, подставляя BUILD_HASH в плейсхолдер.
function emitServiceWorker(buildHash) {
    return {
        name: "ugolok:emit-sw",
        apply: "build",
        generateBundle() {
            // buildHash — replaceAll(str, fn), не replaceAll(str, str): при
            // строковой замене движок трактует `$`-паттерны в buildHash
            // ($&, $$, ...) специально, что портит подстановку.
            const src = readFileSync("service-worker.js", "utf8").replaceAll(
                "__BUILD_HASH__",
                () => buildHash,
            );
            this.emitFile({
                type: "asset",
                fileName: "service-worker.js",
                source: src,
            });
        },
    };
}

export default defineConfig(({ command }) => ({
    base: "./", // переносимость пары файлов на произвольный путь
    server: {
        // Разовый tuna-туннель для проверки с телефона (пользователь, 2026-08-15).
        // Оба пункта нашлись по факту EOF в тоннеле, не по документации:
        // (1) без host Vite слушал только IPv6 [::1] — tuna целится в 127.0.0.1
        //     (IPv4) буквально, туда никто не отвечал (`nc` -> Connection refused).
        //     "127.0.0.1", не true — не открываем 0.0.0.0/LAN, только то, во что
        //     метит именно tuna.
        // (2) без allowedHosts Vite рвёт соединение на чужом Host-заголовке
        //     (защита от DNS rebinding) — тоже выглядело бы как EOF.
        // Убрать после теста, если туннель больше не нужен.
        host: "127.0.0.1",
        allowedHosts: ["ory3yt-150-241-83-79.ru.tuna.am"],
    },
    plugins: [
        preact({ devToolsEnabled: false }), // обход бага preset×Vite8×zimmerframe
        emitServiceWorker(BUILD_HASH),
        viteSingleFile(),
        ...(command === "serve"
            ? [
                  devRelayPlugin(),
                  devBlossomPlugin(),
                  devTurnPlugin(),
                  devServiceWorkerPlugin(),
              ]
            : []),
    ],
    define: {
        __BUILD_HASH__: JSON.stringify(BUILD_HASH),
        __BUILD_DEFAULT_RELAYS__: JSON.stringify(buildDefaultRelays()),
        __BUILD_BOOTSTRAP_RELAYS__: JSON.stringify(buildBootstrapRelays()),
        __BUILD_DEFAULT_BLOSSOM_SERVERS__: JSON.stringify(
            buildDefaultBlossomServers(),
        ),
        __BUILD_DEFAULT_ICE_SERVERS__: JSON.stringify(buildDefaultIceServers()),
        __BUILD_ADMIN_PUBKEY__: JSON.stringify(buildAdminPubkey()),
    },
    build: {
        target: ["chrome100", "firefox100", "safari15.4"], // = твои min-браузеры
    },
}));
