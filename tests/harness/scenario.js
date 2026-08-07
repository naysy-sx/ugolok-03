import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEVICE_SCRIPT = fileURLToPath(new URL("./device.js", import.meta.url));
const LOADER_URL = new URL("./node-loader.mjs", import.meta.url).href;

export function spawnDevice() {
	// --experimental-loader подменяет ТОЛЬКО специфичный для vite специфкатор
	// crypto.worker.js?worker&inline (node-loader.mjs) — device.js импортирует
	// НАСТОЯЩИЙ transport.js, который иначе не грузится под голым node.
	const child = fork(DEVICE_SCRIPT, [], {
		stdio: "inherit",
		execArgv: [...process.execArgv, "--experimental-loader", LOADER_URL, "--no-warnings"],
	});
	let nextId = 1;
	const pending = new Map();

	child.on("message", ({ id, ok, result, error }) => {
		const p = pending.get(id);
		if (!p) return;
		pending.delete(id);
		if (ok) p.resolve(result);
		else p.reject(new Error(error));
	});

	function call(cmd, args = {}) {
		return new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			child.send({ id, cmd, args });
		});
	}

	function kill() {
		child.kill();
	}

	return { call, kill, process: child };
}
