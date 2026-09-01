import { db } from '../../../core/store/database.js';
import { fromEncryptedRow } from '../../../core/store/encrypted-table.js';

export const commentsSource = {
  type: 'comment',
  order: 'unordered',
  async *scan(ctx, { signal }) {
    const rows = await db.table('comments').where('ownerPubkey').equals(ctx.ownerPubkey).toArray();
    for (const row of rows) {
      if (signal.aborted) return;
      if (row.deleted) continue;

      const comment = fromEncryptedRow(row, ctx.dbKey);
      yield { key: row.id, sortKey: null, fields: [comment.text ?? ''] };
    }
  }
};
