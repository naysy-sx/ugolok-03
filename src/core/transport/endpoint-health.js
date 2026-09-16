// Одна попытка без ретрая на нестабильной сети (Wi-Fi роуминг, спутник,
// перегруженный relay/coturn под нагрузкой) — это монетка, не проверка: та
// же сеть за 2.5с то укладывается, то нет от перезагрузки к перезагрузке.
// withRetry() даёт probe-функциям несколько попыток, прежде чем сдаться —
// см. connection-endpoints.jsx, где он оборачивает каждую из трёх проверок.
export async function withRetry(probe, { attempts = 3, delayMs = 700, isCancelled = () => false } = {}) {
	let result = { ok: false, ms: null };
	for (let i = 0; i < attempts; i++) {
		if (isCancelled()) return result;
		result = await probe();
		if (result.ok || isCancelled()) return result;
		if (i < attempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return result;
}

export async function probeRelay(url, { timeoutMs = 4000 } = {}) {
	if (typeof globalThis.WebSocket !== "function") {
		return { ok: false, ms: null, error: "no WebSocket" };
	}
	const started = Date.now();
	let ws;
	try {
		ws = new globalThis.WebSocket(url);
	} catch (e) {
		return { ok: false, ms: null, error: String(e) };
	}
	return new Promise((resolve) => {
		let done = false;
		const finish = (ok) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {
				// already closed
			}
			resolve({ ok, ms: ok ? Math.max(0, Date.now() - started) : null });
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		ws.onopen = () => finish(true);
		ws.onerror = () => finish(false);
	});
}

export async function probeBlossom(url, { timeoutMs = 4000 } = {}) {
	if (typeof globalThis.fetch !== "function") {
		return { ok: false, ms: null, error: "no fetch" };
	}
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await globalThis.fetch(url, { method: "GET", signal: controller.signal });
		const ok = response.status >= 200 && response.status < 500;
		return { ok, ms: ok ? Math.max(0, Date.now() - started) : null };
	} catch {
		return { ok: false, ms: null };
	} finally {
		clearTimeout(timer);
	}
}

export async function probeIce(iceServers, { timeoutMs = 5000 } = {}) {
	if (typeof globalThis.RTCPeerConnection !== "function") {
		return { ok: false, ms: null, error: "no RTCPeerConnection" };
	}
	const started = Date.now();
	let pc;
	try {
		// iceTransportPolicy: "relay" — без него первый пришедший кандидат почти
		// всегда host (локальный интерфейс, не требует ни STUN, ни TURN) и
		// finish(true) сработает мгновенно ДО того, как TURN-сервер вообще
		// ответит — проверка называется "проба TURN", но по факту не проверяла
		// бы TURN вообще, только что RTCPeerConnection способен собирать
		// кандидаты. Живая проверка (прод, 2026-09-06): без relay первый
		// кандидат — typ host; с relay — именно typ relay от coturn.
		pc = new globalThis.RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
	} catch (e) {
		return { ok: false, ms: null, error: String(e) };
	}
	return new Promise((resolve) => {
		let done = false;
		const finish = (ok) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				pc.close();
			} catch {
				// already closed
			}
			resolve({ ok, ms: ok ? Math.max(0, Date.now() - started) : null });
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		pc.onicecandidate = (ev) => {
			if (ev && ev.candidate) finish(true);
		};
		pc.onicegatheringstatechange = () => {
			if (pc.iceGatheringState === "complete") finish(true);
		};
		try {
			pc.createDataChannel("probe");
			pc.createOffer()
				.then((offer) => pc.setLocalDescription(offer))
				.catch(() => finish(false));
		} catch {
			finish(false);
		}
	});
}
