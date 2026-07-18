import { db } from '../store/database.js';

export async function loadChatWindow(ownerPubkey, contactPubkey, { limit = 100, beforeSeq } = {}) {
    // [ownerPubkey+chatId] (db.version(4), owner-scoping — см. database.js).
    let rows = await db.table('messages').where('[ownerPubkey+chatId]').equals([ownerPubkey, contactPubkey]).toArray();
    
    rows.sort((a, b) => {
        if (a.lamportTs !== b.lamportTs) return a.lamportTs - b.lamportTs;
        if (a.senderPubkey !== b.senderPubkey) return a.senderPubkey < b.senderPubkey ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    let source = rows;
    if (beforeSeq !== undefined) {
        let index = source.findIndex(m => m.seq === beforeSeq);
        if (index !== -1) source = source.slice(0, index);
    }

    let windowMessages = source.slice(-limit);
    let hasMore = source.length > limit;

    return { messages: windowMessages, hasMore };
}

export async function markWindowLoaded(ownerPubkey, contactPubkey, oldestLoadedSeq) {
    let existing = await db.table('chatSyncState').get([ownerPubkey, contactPubkey]);
    await db.table('chatSyncState').put({ ...existing, ownerPubkey, chatId: contactPubkey, oldestLoadedSeq });
}
