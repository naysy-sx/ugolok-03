import { encryptRow, decryptRow } from "../crypto/db-crypto.js";

// Этап 39 — правка контракта (было: wrapEncryptedTable, put/get-only обёртка
// над целым table-инстансом). Реальное использование Dexie в доменном слое
// гораздо разнообразнее (where().equals().toArray(), bulkAdd, modify, first) —
// оборачивать под это весь Collection API не нужно. Взамен — два stateless
// хелпера: доменный код продолжает звать РЕАЛЬНЫЙ db.table(X) напрямую и просто
// пропускает объект через них на границе записи/чтения. Все Dexie-запросы,
// оперирующие только plaintext-полями (.where/.equals/.delete/.bulkDelete),
// работают без каких-либо изменений — см. DESIGN.md, этап 39.
export function toEncryptedRow(record, plaintextFields, dbKey) {
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
  return { ...plain, nonce, ciphertext };
}

export function fromEncryptedRow(row, dbKey) {
  if (row === undefined) return undefined;
  const { nonce, ciphertext, ...plain } = row;
  const sensitive = decryptRow({ nonce, ciphertext }, dbKey);
  return { ...plain, ...sensitive };
}
