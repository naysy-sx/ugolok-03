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
