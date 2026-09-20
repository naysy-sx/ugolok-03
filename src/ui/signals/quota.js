// ТЗ-04 — состояние квоты в памяти. Клиент спрашивает сервер (GET /api/quota) при входе и
// после каждой успешной заливки/освобождения места; фоновой периодики нет.
import { signal, effect } from "@preact/signals";
import { currentUser, privKeySig } from "./auth.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { fetchQuota } from "../../core/transport/blossom-client.js";
import { normalizeQuota } from "../../domain/uploads/quota.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// status: unknown (не спрашивали) | loading | ok | unsupported (старый сервер без квот) | error
export const quotaState = signal({ status: "unknown", quota: null, at: 0 });

let inflight = null;
let timer = null;
let generation = 0;

// Снимок для проверок в лотке; null — значения неизвестны (сервер недоступен / без квот):
// тогда действует только зашитая страховка размера файла.
export function getQuotaSnapshot() {
	const s = quotaState.value;
	return s.status === "ok" ? s.quota : null;
}

export async function refreshQuota() {
	const user = currentUser.peek();
	const priv = privKeySig.peek();
	if (!user || !priv || !BLOSSOM_URL) return quotaState.value;
	if (inflight) return inflight;
	const gen = generation;
	quotaState.value = { ...quotaState.value, status: quotaState.value.quota ? "ok" : "loading" };
	inflight = (async () => {
		try {
			const quota = normalizeQuota(await fetchQuota(BLOSSOM_URL, priv));
			if (gen === generation) quotaState.value = { status: quota ? "ok" : "error", quota, at: Date.now() };
		} catch (err) {
			if (gen !== generation) return quotaState.value;
			// 404 — сервер без квот (старый образ): не ошибка, просто ограничений нет
			quotaState.value = err?.status === 404 ? { status: "unsupported", quota: null, at: Date.now() } : { status: "error", quota: quotaState.value.quota, at: Date.now() };
		} finally {
			inflight = null;
		}
		return quotaState.value;
	})();
	return inflight;
}

// После заливки/освобождения — обновить остаток (с небольшой задержкой: несколько блобов
// одного вложения подряд не должны давать несколько запросов).
export function scheduleQuotaRefresh(delayMs = 800) {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		refreshQuota();
	}, delayMs);
}

effect(() => {
	const user = currentUser.value;
	generation += 1;
	if (timer) clearTimeout(timer);
	timer = null;
	inflight = null;
	if (!user) {
		quotaState.value = { status: "unknown", quota: null, at: 0 };
		return;
	}
	// ключ появляется синхронно вместе с пользователем (login()), но подстрахуемся микрозадачей
	Promise.resolve().then(() => refreshQuota());
});
