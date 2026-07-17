import { v2, getConversationKey } from "nostr-tools/nip44";

const MAX_PLAINTEXT_BYTES = 65535;

export function encrypt(plaintext, privateKey, recipientPublicKey) {
  const byteLength = new TextEncoder().encode(plaintext).length;
  if (byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error(`nip44: plaintext (${byteLength} байт) превышает лимит ${MAX_PLAINTEXT_BYTES} байт (политика проекта)`);
  }
  const conversationKey = getConversationKey(privateKey, recipientPublicKey);
  return v2.encrypt(plaintext, conversationKey);
}

export function decrypt(payload, privateKey, senderPublicKey) {
  const conversationKey = getConversationKey(privateKey, senderPublicKey);
  return v2.decrypt(payload, conversationKey);
}
