import { db } from "../store/database.js";

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

export async function encryptAndStore(privKey, password, id, meta = {}, mnemonic) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encKey = await deriveEncKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encKey, privKey);
  
  let mnemonicIv;
  let mnemonicCiphertext;
  
  if (mnemonic) {
    mnemonicIv = crypto.getRandomValues(new Uint8Array(12));
    mnemonicCiphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: mnemonicIv }, encKey, new TextEncoder().encode(mnemonic));
  }
  
  await db.table('keystore').put({ id, salt, iv, ciphertext, ...meta, mnemonicIv, mnemonicCiphertext });
}

export async function decryptPrivateKey(password, id) {
  const record = await db.table("keystore").get(id);
  if (!record) {
    throw new Error("keystore: приватный ключ не найден");
  }
  const encKey = await deriveEncKey(password, record.salt);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, encKey, record.ciphertext);
  return new Uint8Array(decrypted);
}

export async function decryptMnemonic(password, id) {
  const record = await db.table('keystore').get(id);
  if (!record) throw new Error('keystore: приватный ключ не найден');
  if (!record.mnemonicCiphertext) throw new Error('keystore: мнемоника не сохранена для этого аккаунта');
  const encKey = await deriveEncKey(password, record.salt);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.mnemonicIv }, encKey, record.mnemonicCiphertext);
  return new TextDecoder().decode(decrypted);
}

export async function listAccounts() {
  const records = await db.table("keystore").toArray();
  return records.map((r) => ({ id: r.id, login: r.login, avatar: r.avatar ?? '', hasMnemonic: !!r.mnemonicCiphertext }));
}

export async function getProfile(id) {
  const record = await db.table("keystore").get(id);
  if (!record) {
    throw new Error("keystore: аккаунт не найден");
  }
  return { login: record.login ?? "", avatar: record.avatar ?? "", bio: record.bio ?? "", avatarUrl: record.avatarUrl ?? "" };
}

export async function updateProfile(id, patch) {
  const updates = {};
  if (patch.avatar !== undefined) updates.avatar = patch.avatar;
  if (patch.bio !== undefined) updates.bio = patch.bio;
  if (patch.avatarUrl !== undefined) updates.avatarUrl = patch.avatarUrl;
  await db.table("keystore").update(id, updates);
}
