// ТЗ-03 — привязка журнала загрузок к сеансу. Импортируется побочным эффектом из
// app.jsx: при входе журнал получает ключи, при блокировке — отвязывается.
// Доменный код (attachments.js, files/*) с UI-сигналами не связан и пишет в журнал
// через domain/uploads/journal.js, который без привязки просто ничего не делает.
import { effect } from "@preact/signals";
import { currentUser, dbKeySig, masterSecretSig } from "./auth.js";
import { publish, fetchJournalEvents, ensureConnected } from "./transport.js";
import { privKeySig } from "./auth.js";
import { deriveJournalKey, deriveJournalSigner } from "../../core/crypto/derivation.js";
import { getOrCreateDeviceId } from "../../domain/identity/device.js";
import { bindJournal, unbindJournal, pullJournal } from "../../domain/uploads/journal.js";

let generation = 0;

effect(() => {
	const user = currentUser.value;
	const dbKey = dbKeySig.value;
	const master = masterSecretSig.value;
	const gen = ++generation;
	if (!user || !dbKey || !master) {
		unbindJournal();
		return;
	}
	getOrCreateDeviceId()
		.then((deviceId) => {
			if (gen !== generation) return; // за это время вышли/сменили аккаунт
			bindJournal({
				ownerPubkey: user.id,
				dbKey,
				journalKey: deriveJournalKey(master),
				journalSigner: deriveJournalSigner(master),
				deviceId,
				publish: (event) => publish(event),
			});
		})
		.catch(() => {});
});

// Догрузка пачек с relay — ТОЛЬКО по требованию (экран хранилища), не при запуске.
export async function pullUploadJournal(options = {}) {
	const user = currentUser.value;
	if (user && privKeySig.value && dbKeySig.value) {
		await ensureConnected(user.id, privKeySig.value, dbKeySig.value);
	}
	return pullJournal({ fetchEvents: fetchJournalEvents, ...options });
}
