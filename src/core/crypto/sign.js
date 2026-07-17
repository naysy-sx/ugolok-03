import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

export function sign(eventTemplate, privateKey) {
  return finalizeEvent(eventTemplate, privateKey);
}

export function verify(event) {
  const clean = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
  return verifyEvent(clean);
}
