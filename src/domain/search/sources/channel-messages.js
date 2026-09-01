import { db } from '../../../core/store/database.js';
import { fromEncryptedRow } from '../../../core/store/encrypted-table.js';
import { paginateReverseByCompoundIndex } from './paginate-reverse.js';

export const channelMessagesSource = {
  type: 'channelMessage',
  order: 'recent',
  async *scan(ctx, { signal }) {
    for await (const row of paginateReverseByCompoundIndex(db.table('channelMessages'), '[ownerPubkey+createdAt]', ctx.ownerPubkey, 'createdAt', { signal, pageSize: 200 })) {
      if (signal.aborted) return;
      if (row.deleted) continue;
      const message = await fromEncryptedRow(row, ctx.dbKey);
      yield {
        key: row.id,
        sortKey: row.createdAt,
        fields: [message.text ?? ''],
        data: { messageId: row.id, channelId: row.channelId, authorPubkey: row.authorPubkey, createdAt: row.createdAt, text: message.text ?? '' }
      };
    }
  }
};
