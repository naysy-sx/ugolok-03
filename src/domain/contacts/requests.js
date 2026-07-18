export const CONTACT_REQUEST_KIND = 3001;

export function buildContactRequestRumor(greeting = '') {
  return { kind: CONTACT_REQUEST_KIND, content: greeting, tags: [], created_at: Math.floor(Date.now() / 1000) };
}

export function parseContactRequestRumor(rumor) {
  return { greeting: rumor.content, senderPubkey: rumor.pubkey, createdAt: rumor.created_at };
}
