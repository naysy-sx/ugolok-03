import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

export function encryptRow(value, dbKey) {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = chacha20poly1305(dbKey, nonce).encrypt(plaintext);
  return { nonce, ciphertext };
}

export function decryptRow(encrypted, dbKey) {
  const plaintext = chacha20poly1305(dbKey, encrypted.nonce).decrypt(encrypted.ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
