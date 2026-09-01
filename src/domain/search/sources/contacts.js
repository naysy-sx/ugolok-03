import { db } from '../../../core/store/database.js';
import { fromEncryptedRow } from '../../../core/store/encrypted-table.js';

export const contactsSource = {
  type: 'contact',
  order: 'unordered',
  async *scan(ctx, { signal }) {
    const contactRelationships = await db.table('contactRelationships').where('[owner+state]').equals([ctx.ownerPubkey, 'CONTACT']).toArray();

    if (contactRelationships.length === 0) return;

    const activeContactSet = new Set(contactRelationships.map(row => row.peer));
    const contactProfiles = await db.table('contactProfiles').where('ownerPubkey').equals(ctx.ownerPubkey).toArray();

    for (const row of contactProfiles) {
      if (signal.aborted) return;
      if (!activeContactSet.has(row.contactPubkey)) continue;

      const profile = fromEncryptedRow(row, ctx.dbKey);
      yield {
        key: row.contactPubkey,
        sortKey: null,
        fields: [profile.name ?? '', profile.about ?? ''],
        data: { contactPubkey: row.contactPubkey, name: profile.name ?? '', about: profile.about ?? '' }
      };
    }
  }
};
