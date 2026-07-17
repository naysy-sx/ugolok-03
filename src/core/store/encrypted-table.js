import { encryptRow, decryptRow } from "../crypto/db-crypto.js";

export function wrapEncryptedTable(table, plaintextFields, dbKey) {
  return {
    async put(record) {
      const plain = {};
      const sensitive = {};
      for (const [key, value] of Object.entries(record)) {
        if (plaintextFields.includes(key)) {
          plain[key] = value;
        } else {
          sensitive[key] = value;
        }
      }
      const { nonce, ciphertext } = encryptRow(sensitive, dbKey);
      return table.put({ ...plain, nonce, ciphertext });
    },

    async get(key) {
      const row = await table.get(key);
      if (row === undefined) return undefined;
      const { nonce, ciphertext, ...plain } = row;
      const sensitive = decryptRow({ nonce, ciphertext }, dbKey);
      return { ...plain, ...sensitive };
    },
  };
}
