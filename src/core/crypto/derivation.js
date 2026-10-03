import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils.js";

export function deriveMasterSecret(privKey) {
  return hkdf(sha256, privKey, utf8ToBytes("Ugolok/v1/master"), utf8ToBytes(""), 32);
}

export function deriveDbKey(masterSecret) {
  return hkdf(sha256, masterSecret, utf8ToBytes("Ugolok/v1/db"), utf8ToBytes(""), 32);
}

export function deriveMirrorKey(masterSecret) {
  return hkdf(sha256, masterSecret, utf8ToBytes("Ugolok/v1/mirror"), utf8ToBytes(""), 32);
}

// ТЗ-03 (журнал загрузок). Пачки журнала подписываются НЕ основным ключом, а
// производным: стартовая синхронизация подписана на все события автора
// ({authors:[я]}, core/sync/bootstrap.js), и журнал, опубликованный от основного
// ключа, тянулся бы на каждом запуске. Производный автор для неё невидим — журнал
// читается только по требованию (экран хранилища). Побочный плюс: relay не может
// связать пачки журнала с аккаунтом. Содержимое шифруется отдельным симметричным
// ключом (не тем, что подпись).
export function deriveJournalKey(masterSecret) {
  return hkdf(sha256, masterSecret, utf8ToBytes("Ugolok/v1/journal-key"), utf8ToBytes(""), 32);
}

export function deriveJournalSigner(masterSecret) {
  return hkdf(sha256, masterSecret, utf8ToBytes("Ugolok/v1/journal-signer"), utf8ToBytes(""), 32);
}

export function opaqueDTag(masterSecret, kind, logicalKey) {
  const input = utf8ToBytes(`${kind}:${logicalKey}`);
  return bytesToHex(hmac(sha256, masterSecret, input));
}
