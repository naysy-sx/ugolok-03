// Этап 39 (DESIGN.md/CONTRACTS.md) — единый источник истины для того, какие поля
// каждой таблицы остаются plaintext (индексы + несекретные enum/флаги/счётчики),
// а какие уходят в зашифрованный blob через toEncryptedRow/fromEncryptedRow
// (encrypted-table.js). Несколько доменных файлов трогают одну и ту же таблицу
// (например channelKeys — channel.js/moderation.js/channel-access.js/post.js/
// comments.js/channel-chat.js/channel-visibility.js) — список полей объявляется
// здесь ОДИН раз, чтобы не разъезжался между файлами.

export const OWN_KEY_PACKAGE_PLAINTEXT_FIELDS = ["ownerPubkey"];

export const MLS_GROUPS_PLAINTEXT_FIELDS = ["ownerPubkey", "groupId"];

export const CHANNEL_KEYS_PLAINTEXT_FIELDS = ["ownerPubkey", "channelId", "keyVersion"];

export const COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS = ["ownerPubkey", "channelId", "keyVersion"];

// Этап 40 (Tier 1 — прямая находка пользователя, CONTRACTS.md).
export const MESSAGES_PLAINTEXT_FIELDS = ["seq", "ownerPubkey", "chatId", "msgId", "lamportTs", "senderPubkey", "id", "status", "deleted"];

export const POSTS_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "channelId", "createdAt", "deleted", "status", "keyVersion"];

export const COMMENTS_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "postId", "parentId", "deleted"];

export const CHANNEL_MESSAGES_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "channelId", "createdAt", "deleted", "authorPubkey"];

export const CHANNELS_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "channelTopic", "role", "creatorPubkey", "createdAt", "allowChatAttachments"];

// Этап 41 (Tier 2 — соцграф, CONTRACTS.md). groupMembers/contacts/blockedContacts
// не шифруются вовсе (голые pubkey-списки без отдельного "контента", TECH.md/DESIGN.md
// этапа 41) — только groups.name содержательна.
export const GROUPS_PLAINTEXT_FIELDS = ["owner", "id"];

// Этап 42 (Tier 3 — модерация/черновики, CONTRACTS.md). channelIgnores/
// bannedMembers/channelVisibilityGroups/channelReaders не шифруются вовсе (голые
// id/pubkey-списки, тот же принцип, что groupMembers/contacts на этапе 41).
export const CHAT_SYNC_STATE_PLAINTEXT_FIELDS = ["ownerPubkey", "chatId", "lastReadLamportTs", "oldestLoadedSeq"];

export const CONTACT_REQUESTS_PLAINTEXT_FIELDS = ["owner", "senderPubkey"];

// createdAt — единственное поле с ОТДЕЛЬНЫМ одноколоночным индексом (database.js,
// db.version(3)) — обязано остаться plaintext, иначе индекс не построить.
export const INBOX_REQUESTS_PLAINTEXT_FIELDS = ["owner", "senderPubkey", "createdAt"];

export const CHANNEL_REPORTS_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "channelId", "viewed", "reporterPubkey", "targetPubkey", "contentType", "contentId", "reason"];

// Этап 45 (Tier 4 — низкий приоритет/спорная ценность, CONTRACTS.md). Ценность
// шифрования здесь спорная (метаданные/счётчик/событие и так скоро публичное) —
// реализовано ради полноты AC-16 по явному выбору пользователя.
export const UI_SETTINGS_PLAINTEXT_FIELDS = ["ownerPubkey"];

export const OUTBOX_PLAINTEXT_FIELDS = ["seq", "eventId", "status", "retryCount"];

export const CHANNEL_KEY_META_PLAINTEXT_FIELDS = ["ownerPubkey", "channelId"];

// Этап 49 — contactRelationships (единая таблица, CONTACTS-FSM.md §3). state/
// resolvedAt/sentAt — структурные метаданные и индексы ([owner+peer], [owner+state]
// требуют plaintext), тот же принцип, что contacts/blockedContacts на этапе 41.
// greeting — единственное содержательное поле (текст приветствия заявки), остаётся
// зашифрованным — прямое продолжение CONTACT_REQUESTS_PLAINTEXT_FIELDS.
export const CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS = ["owner", "peer", "state", "resolvedAt", "sentAt"];

// Этап 50 — journalEntries (фича "Журнал", CONTACTS-FSM.md §7). id/owner/
// createdAt/category/read — структурные метаданные и индексы; title/body/
// navTarget — содержательные поля (текст уведомления + куда перейти),
// остаются зашифрованными — прямое продолжение CONTACT_REQUESTS_PLAINTEXT_FIELDS.
export const JOURNAL_ENTRIES_PLAINTEXT_FIELDS = ["id", "owner", "createdAt", "category", "read"];
