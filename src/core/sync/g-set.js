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
