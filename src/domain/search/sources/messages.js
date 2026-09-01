import { db } from '../../../core/store/database.js';
import { fromEncryptedRow } from '../../../core/store/encrypted-table.js';
import { paginateReverseByPrimaryKey } from './paginate-reverse.js';

export const messagesSource = {
  type: 'message',
  order: 'recent',
  async *scan(ctx, { signal }) {
    for await (const row of paginateReverseByPrimaryKey(db.table('messages'), 'ownerPubkey', ctx.ownerPubkey, { signal, pageSize: 200 })) {
      if (signal.aborted) return;
      if (row.deleted) continue;
      const message = fromEncryptedRow(row, ctx.dbKey);
      yield { key: row.id, sortKey: row.seq, fields: [message.text ?? ''] };
    }
  }
};
