import { wrapEvent, unwrapEvent } from "nostr-tools/nip59";

export function wrap(rumorTemplate, privateKey, recipientPublicKey) {
  return wrapEvent(rumorTemplate, privateKey, recipientPublicKey);
}

export function unwrap(giftWrap, privateKey) {
  return unwrapEvent(giftWrap, privateKey);
}
