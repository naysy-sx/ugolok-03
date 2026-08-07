import { parentPort } from "node:worker_threads";
import * as Comlink from "comlink";
import nodeEndpoint from "comlink/dist/esm/node-adapter.mjs";
import { verify } from "../../src/core/crypto/sign.js";

// Node-эквивалент src/workers/crypto.worker.js (Vite ?worker&inline годится
// только под vite dev/build — node:worker_threads не даёт `self`, на котором
// Comlink.expose() держится по умолчанию в браузере). Реализация api —
// РОВНО та же (batchVerify -> verify на каждое событие, реальная схема
// подписи, ничего не переизобретено) — переиспользована только обвязка
// Comlink/Worker, не крипто-логика.
const api = {
	batchVerify(events) {
		return events.map((event) => verify(event));
	},
};

Comlink.expose(api, nodeEndpoint(parentPort));
