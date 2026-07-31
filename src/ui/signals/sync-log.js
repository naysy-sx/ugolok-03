import { signal } from "@preact/signals";

export const syncLog = signal([]);

export function resetSyncLog() {
  syncLog.value = [];
}

export function logSync(text) {
  syncLog.value = [...syncLog.value, { ts: Date.now(), text }];
}
