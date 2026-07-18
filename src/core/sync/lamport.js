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

export async function computeInitialLamportValue() {
  const messages = await db.table('messages').toArray();
  const maxLamportTs = messages.length > 0 ? Math.max(...messages.map(msg => msg.lamportTs)) : 0;
  return maxLamportTs + 1;
}

export async function persistLamportValue(value) {
  await db.table('clock').put({ id: 'lamport', value });
}
