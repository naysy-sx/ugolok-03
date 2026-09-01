import { db } from '../../../core/store/database.js';
import { fromEncryptedRow } from '../../../core/store/encrypted-table.js';

export const channelsSource = {
  type: 'channel',
  order: 'unordered',
  async *scan(ctx, { signal }) {
    const rows = await db.table('channels').where('ownerPubkey').equals(ctx.ownerPubkey).toArray();
    for (const row of rows) {
      if (signal.aborted) {
        return;
      }
      const channel = fromEncryptedRow(row, ctx.dbKey);
      yield { key: row.id, sortKey: null, fields: [channel.name ?? '', channel.description ?? '', channel.rules ?? ''] };
    }
  }
};
