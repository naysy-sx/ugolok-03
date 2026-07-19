import { db } from '../store/database.js';

export function createLamportClock(initialValue = 0) {
  let value = initialValue;
  return {
    tick() {
      value += 1;
      return value;
    },
    receive(remoteT) {
      value = Math.max(value, remoteT) + 1;
      return value;
    },
    getValue() {
      return value;
    }
  };
}

// ownerPubkey (owner-scoping, db.version(11)) — найдено реальным использованием
// (мультиаккаунт в разных вкладках одного браузера/origin): без фильтра здесь
// max(lamportTs) считался по messages ВСЕХ локальных аккаунтов разом.
export async function computeInitialLamportValue(ownerPubkey) {
  const messages = await db.table('messages').where('ownerPubkey').equals(ownerPubkey).toArray();
  const maxLamportTs = messages.length > 0 ? Math.max(...messages.map(msg => msg.lamportTs)) : 0;
  return maxLamportTs + 1;
}

export async function persistLamportValue(ownerPubkey, value) {
  await db.table('clock').put({ ownerPubkey, id: 'lamport', value });
}
