// Этап 39 (DESIGN.md/CONTRACTS.md) — единый источник истины для того, какие поля
// каждой таблицы остаются plaintext (индексы + несекретные enum/флаги/счётчики),
// а какие уходят в зашифрованный blob через toEncryptedRow/fromEncryptedRow
// (encrypted-table.js). Несколько доменных файлов трогают одну и ту же таблицу
// (например channelKeys — channel.js/moderation.js/channel-access.js/post.js/
// comments.js/channel-chat.js/channel-visibility.js) — список полей объявляется
// здесь ОДИН раз, чтобы не разъезжался между файлами.

export const OWN_KEY_PACKAGE_PLAINTEXT_FIELDS = ["ownerPubkey"];

// Этап 73.5 — consecutiveDecryptFailures/desynced (М6, детект расхождения):
// диагностические метаданные, не содержание — plaintext, не индексируются
// (db-версия не бампается, Dexie не требует схемы для неиндексируемых полей).
export const MLS_GROUPS_PLAINTEXT_FIELDS = ["ownerPubkey", "groupId", "consecutiveDecryptFailures", "desynced"];

export const CHANNEL_KEYS_PLAINTEXT_FIELDS = ["ownerPubkey", "channelId", "keyVersion"];

// Этап 53 И6 — по прямому образцу CHANNEL_KEYS/CHANNEL_KEY_META выше.
export const FILES_SHARES_PLAINTEXT_FIELDS = ["ownerPubkey", "nodeId"];
export const FILES_SHARE_KEYS_PLAINTEXT_FIELDS = ["ownerPubkey", "nodeId", "version"];
// Сторона получателя (mount.js) — ownerPubkey здесь означает получателя.
export const FILES_MOUNTS_PLAINTEXT_FIELDS = ["ownerPubkey", "nodeId"];
export const FILES_MOUNT_KEYS_PLAINTEXT_FIELDS = ["ownerPubkey", "nodeId", "version"];

// Этап 74 — Часть C, C-2 (CONTRACTS.md/DESIGN.md "Этап 74"): lastEventId —
// id события, применившего текущую ревизию (вместе с updatedAt/createdAt —
// пара для isNewerVersion, T7) — LWW-гейт живого пути 30054, старая ревизия
// той же keyVersion (F-CH-05: несколько ревизий без ротации ключа) не
// откатывает список читателей.
export const COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS = ["ownerPubkey", "channelId", "keyVersion", "lastEventCreatedAt", "lastEventId"];

// Этап 40 (Tier 1 — прямая находка пользователя, CONTRACTS.md).
export const MESSAGES_PLAINTEXT_FIELDS = ["seq", "ownerPubkey", "chatId", "msgId", "lamportTs", "senderPubkey", "id", "status", "deleted"];

// Этап 74 — Часть C, C-2: lastEventCreatedAt/lastEventId — версия ПОСЛЕДНЕЙ
// применённой ревизии (отдельно от createdAt, который фиксирован с первого
// приёма — хронологическая позиция поста в ленте, не трогается republish'ем).
// LWW-гейт живого пути 30061 — archivePost/unpublishPost/edit republish-ят
// тот же d-tag, старая версия не должна откатывать status/text.
//
// Редизайн интерфейса, этап 1 (CONTRACTS.md) — dueAt/done открыты НАМЕРЕННО
// (нужен индекс [ownerPubkey+dueAt] для выборки "Сегодня" без полного
// перебора, этап 4): сырой дамп локальной БД раскрывает наличие и дату
// срока, но не текст. title/linkUrl остаются зашифрованными.
export const POSTS_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "channelId", "createdAt", "deleted", "status", "keyVersion", "lastEventCreatedAt", "lastEventId", "dueAt", "done"];

export const COMMENTS_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "postId", "parentId", "deleted"];

export const CHANNEL_MESSAGES_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "channelId", "createdAt", "deleted", "authorPubkey"];

// Этап 74 — Часть C, C-2: lastEventId — LWW-гейт живого пути 30060 (editChannel
// republish, тот же d-tag) — старая версия не должна откатывать name/description/
// rules. updatedAt уже существовал (event.created_at последнего применения) —
// lastEventId довершает пару для isNewerVersion (тайбрейк при равном created_at).
export const CHANNELS_PLAINTEXT_FIELDS = ["ownerPubkey", "id", "channelTopic", "role", "creatorPubkey", "createdAt", "updatedAt", "allowChatAttachments", "lastEventId"];

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

// Этап 73.3 — И3 (единственный коммиттер): исходящие, накопленные проигравшей
// стороной, пока коммиттер не создал группу. text/attachment — содержательные,
// шифруются; ownerPubkey/contactPubkey/lamportTs — составной индекс, plaintext.
export const PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS = ["ownerPubkey", "contactPubkey", "lamportTs"];

// Этап 74 — T2.3 (единственный писатель MLS-состояния): журнал уже
// обработанных kind:445 для дедупликации между вкладками. Все поля
// индексно-плоские — eventId уже публичен на relay, firstSeenAt нужен для
// TTL-sweep, шифровать нечего, но toEncryptedRow применяется для
// единообразия со всеми таблицами проекта.
export const PROCESSED_GROUP_EVENTS_PLAINTEXT_FIELDS = ["ownerPubkey", "eventId", "firstSeenAt"];

// Этап 74 — Часть B, T5.2: персист профилей контактов. Только составной
// индекс plaintext (нужен для .get/.where-гидратации) — name/about/
// picture/createdAt/id шифруются (прецедент contactRelationships:
// содержательные поля шифруются, структурные индексы — нет).
export const CONTACT_PROFILES_PLAINTEXT_FIELDS = ["ownerPubkey", "contactPubkey"];

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

// Редизайн интерфейса, этап 5 (CONTRACTS.md) — chatActivity: свежесть
// переписок для сортировки боковой панели (этап 10). Все поля plaintext
// (REDESIGN-SPEC.md: "Всё открыто, ничего не шифруется") — шифровать
// нечего, toEncryptedRow применяется для единообразия (тот же приём, что
// PROCESSED_GROUP_EVENTS_PLAINTEXT_FIELDS выше).
export const CHAT_ACTIVITY_PLAINTEXT_FIELDS = ["ownerPubkey", "chatId", "lastAt", "lastFrom"];
