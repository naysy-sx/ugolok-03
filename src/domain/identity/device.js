import { db } from '../../core/store/database.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export async function getOrCreateDeviceId() {
  let row = await db.table('deviceIdentity').get('self');
  
  if (row) {
    return row.deviceId;
  } else {
    const deviceId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    await db.table('deviceIdentity').put({ id: 'self', deviceId });
    return deviceId;
  }
}
