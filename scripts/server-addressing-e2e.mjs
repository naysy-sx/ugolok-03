#!/usr/bin/env node
// ТЗ-05 приёмка п.2/5/6/9 на живых Blossom: два сервера A (свой, self-host) и B (по умолчанию у получателя).
//   node scripts/server-addressing-e2e.mjs <urlA> <urlB>
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { loadRuntimeConfig, resetRuntimeConfig } from "../src/domain/settings/runtime-config.js";
import { uploadTarget, registerUserServers, resetUserServers } from "../src/domain/files/servers.js";
import { uploadMessageAttachment, downloadMessageAttachment } from "../src/domain/messaging/attachments.js";
import { resetRememberedServers } from "../src/domain/files/blob.js";
import { clearManifestCache } from "../src/domain/files/content.js";

const [A, B] = process.argv.slice(2);
let fails = 0;
const ok = (n, c, x = "") => { console.log((c ? "ok   " : "FAIL ") + n + (x ? " — " + x : "")); if (!c) fails++; };
const priv = crypto.getRandomValues(new Uint8Array(32));
const cfg = (servers) => loadRuntimeConfig({ fetchImpl: async () => ({ ok: true, json: async () => ({ blossomServers: servers }) }) });
const list = async (url) => (await (await fetch(`${url}/stats`)).json?.().catch(() => null));
const bytes = crypto.getRandomValues(new Uint8Array(50000));

// отправитель: config.json указывает на A
await cfg([A]);
ok("config.json перекрывает константу сборки: uploadTarget = A", uploadTarget() === A, uploadTarget());
const desc = await uploadMessageAttachment(uploadTarget(), bytes, { mime: "application/pdf", name: "x.pdf" }, priv, {});
ok("дескриптор несёт подсказку", JSON.stringify(desc.servers) === JSON.stringify([A]), JSON.stringify(desc.servers));
const onB = await fetch(`${B}/${desc.manifestDigest}`);
ok("на сервере по умолчанию (B) блоба нет", onB.status === 404, "status " + onB.status);

// получатель: по умолчанию B
resetRuntimeConfig(); resetUserServers(); resetRememberedServers();
await cfg([B]);
const withHint = await downloadMessageAttachment(desc, { serverUrl: uploadTarget() });
ok("подсказка сработала: файл с A открылся у получателя с сервером B", Buffer.compare(Buffer.from(withHint), Buffer.from(bytes)) === 0);
resetRememberedServers();
clearManifestCache();
const { servers: _drop, ...old } = desc;
let noHint;
try { await downloadMessageAttachment(old, { serverUrl: uploadTarget() }); } catch (e) { noHint = e; }
ok("сообщение без подсказки (старое) ищет только у себя — здесь его нет", noHint?.status === 404 || /404/.test(noHint?.message ?? ""), String(noHint?.message));

// настройка пользователя перекрывает config.json
registerUserServers({ activeUrl: A, urls: [A] });
ok("настройка пользователя перекрывает config.json", uploadTarget() === A);
console.log(fails ? `\n${fails} проверок не прошло` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
