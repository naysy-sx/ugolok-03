export async function probeRelay(url, { timeoutMs = 2500 } = {}) {
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

export async function probeBlossom(url, { timeoutMs = 2500 } = {}) {
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

export async function probeIce(iceServers, { timeoutMs = 3000 } = {}) {
	if (typeof globalThis.RTCPeerConnection !== "function") {
		return { ok: false, ms: null, error: "no RTCPeerConnection" };
	}
	const started = Date.now();
	let pc;
	try {
		pc = new globalThis.RTCPeerConnection({ iceServers });
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
