import { matchFilters } from "nostr-tools";

export function createFakeRelay({ onDeliver }) {
  const events = [];
  const subscriptions = new Map();
  const pending = [];

  const publish = (connId, event) => {
    events.push(event);
    subscriptions.forEach(sub => {
      if (matchFilters(sub.filters, event)) {
        pending.push({ connId: sub.connId, subId: sub.subId, msg: ["EVENT", sub.subId, event] });
      }
    });
    pending.push({ connId, subId: undefined, msg: ["OK", event.id, true, ""] });
    return { ok: true };
  };

  const subscribe = (connId, subId, filters) => {
    subscriptions.set(`${connId}::${subId}`, { connId, subId, filters });
    const eventsToDeliver = events.filter(event => matchFilters(filters, event));
    pending.push(...eventsToDeliver.map(event => ({ connId, subId, msg: ["EVENT", subId, event] })));
    pending.push({ connId, subId, msg: ["EOSE", subId] });
  };

  const unsubscribe = (connId, subId) => {
    subscriptions.delete(`${connId}::${subId}`);
  };

  const disconnect = (connId) => {
    subscriptions.forEach((sub, key) => {
      if (sub.connId === connId) subscriptions.delete(key);
    });
  };

  const pendingCopy = () => [...pending];

  const flushNext = () => {
    if (pending.length > 0) {
      const { connId, msg } = pending.shift();
      onDeliver(connId, msg);
      return true;
    }
    return false;
  };

  const flushAll = () => {
    while (pending.length > 0) {
      flushNext();
    }
  };

  const reorder = (compareFn) => {
    pending.sort(compareFn);
  };

  return {
    publish,
    subscribe,
    unsubscribe,
    disconnect,
    pending: pendingCopy,
    flushNext,
    flushAll,
    reorder
  };
}
