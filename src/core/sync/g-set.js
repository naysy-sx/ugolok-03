import { db } from "../store/database.js";
import { hasEvent, appendEvent } from "../store/event-log.js";

export async function mergeEvent(event) {
  return db.transaction("rw", db.events, async () => {
    if (await hasEvent(event.id)) {
      return { added: false };
    }
    await appendEvent(event);
    return { added: true };
  });
}

export async function mergeEvents(events) {
  const addedIds = [];
  return db.transaction("rw", db.events, async () => {
    for (const event of events) {
      if (!(await hasEvent(event.id))) {
        await appendEvent(event);
        addedIds.push(event.id);
      }
    }
    return { addedIds };
  });
}
