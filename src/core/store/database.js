import Dexie from "dexie";

export const db = new Dexie("ugolok");
db.version(1).stores({
  events: "++seq, id, [pubkey+kind], created_at, *flatTags",
  contacts: "[owner+pubkey], owner",
  blockedContacts: "[owner+pubkey], owner",
  groups: "[owner+id], owner",
  groupMembers: "[groupId+pubkey], groupId",
  permissions: "[owner+subject+resource], owner, subject, resource",
  effectivePerms: "[owner+subject+resource], owner, subject, resource",
  channelKeys: "[channelId+keyVersion], channelId",
  channelKeyMeta: "channelId",
  channelTopics: "channelId",
  commentAllowlists: "[channelId+keyVersion], channelId",
  messages: "++seq, [chatId+lamportTs+senderPubkey+id], chatId, id, status, deleted",
  channels: "id, owner",
  posts: "id, [channelId+created_at], channelId, author, keyVersion, deleted",
  comments: "[authorPubkey+commentId], postId, parentId, keyVersion, deleted",
  attachments: "sha256, messageId, type, mime",
  keystore: "id",
  clock: "id",
  syncState: "relay",
  chatSyncState: "chatId",
  channelSyncState: "channelId",
  outbox: "++seq, eventId, status, retryCount",
  inboxRequests: "id, senderPubkey, created_at",
  deletions: "targetId, deleterPubkey, created_at"
});
