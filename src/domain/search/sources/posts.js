import { db } from '../../../core/store/database.js';
import { fromEncryptedRow } from '../../../core/store/encrypted-table.js';
import { paginateReverseByCompoundIndex } from './paginate-reverse.js';

export const postsSource = {
  type: 'post',
  order: 'recent',
  async *scan(ctx, { signal }) {
    for await (const row of paginateReverseByCompoundIndex(db.table('posts'), '[ownerPubkey+createdAt]', ctx.ownerPubkey, 'createdAt', { signal, pageSize: 200 })) {
      if (signal.aborted) return;
      if (row.deleted || row.status === 'draft') continue;
      const post = await fromEncryptedRow(row, ctx.dbKey);
      yield {
        key: row.id,
        sortKey: row.createdAt,
        fields: [post.title ?? '', post.text ?? ''],
        data: { postId: row.id, channelId: row.channelId, createdAt: row.createdAt, title: post.title ?? '', text: post.text ?? '' }
      };
    }
  }
};
