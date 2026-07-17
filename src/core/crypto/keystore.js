import { db } from "../store/database.js";

const KEYSTORE_ID = "privkey";

async function deriveEncKey(password, salt) {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptAndStore(privKey, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encKey = await deriveEncKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encKey, privKey);
  await db.table("keystore").put({ id: KEYSTORE_ID, salt, iv, ciphertext });
}

export async function decryptPrivateKey(password) {
  const record = await db.table("keystore").get(KEYSTORE_ID);
  if (!record) {
    throw new Error("keystore: приватный ключ не найден");
  }
  const encKey = await deriveEncKey(password, record.salt);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, encKey, record.ciphertext);
  return new Uint8Array(decrypted);
}
