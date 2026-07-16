import { db } from './database.js';

export async function appendEvent(event) {
  const flatTags = event.tags.flatMap(tag => tag.length >= 2 ? [`${tag[0]}:${tag[1]}`] : []);
  return await db.events.add({ ...event, flatTags });
}

export async function getEventById(id) {
  return await db.events.where('id').equals(id).first();
}

export async function hasEvent(id) {
  const count = await db.events.where('id').equals(id).count();
  return count > 0;
}

export async function queryEvents(filter) {
  const all = await db.events.toArray();
  let result = all;

  if (filter.ids) {
    result = result.filter(e => filter.ids.includes(e.id));
  }

  if (filter.authors) {
    result = result.filter(e => filter.authors.includes(e.pubkey));
  }

  if (filter.kinds) {
    result = result.filter(e => filter.kinds.includes(e.kind));
  }

  if (filter.since !== undefined) {
    result = result.filter(e => e.created_at >= filter.since);
  }

  if (filter.until !== undefined) {
    result = result.filter(e => e.created_at <= filter.until);
  }

  for (const key in filter) {
    if (key.startsWith('#')) {
      const tagName = key.slice(1);
      const values = filter[key];
      result = result.filter(e => (e.flatTags || []).some(ft => values.some(v => ft === tagName + ':' + v)));
    }
  }

  result.sort((a, b) => a.created_at - b.created_at);

  if (filter.limit !== undefined) {
    result = result.slice(0, filter.limit);
  }

  return result;
}
