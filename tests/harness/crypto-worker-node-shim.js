import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import nodeEndpoint from "comlink/dist/esm/node-adapter.mjs";

const WORKER_PATH = fileURLToPath(new URL("./crypto-worker-node.mjs", import.meta.url));

// Подменяет src/workers/crypto.worker.js?worker&inline (см. node-loader.mjs) —
// та же роль конструктора (`new CryptoWorker()` в transport.js), но
// возвращает УЖЕ обёрнутый nodeEndpoint(), совместимый с Comlink.wrap() без
// правки вызывающего кода transport.js (там `Comlink.wrap(cryptoWorker)`
// без второго аргумента — в браузере это работает "из коробки" на настоящем
// Worker, здесь роль browser-адаптера берёт на себя nodeEndpoint()).
export default function CryptoWorker() {
	return nodeEndpoint(new Worker(WORKER_PATH));
}
