import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes } from "@noble/ciphers/utils.js";

export function encryptFile(fileBytes) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = chacha20poly1305(key, nonce).encrypt(fileBytes);
  return { key, blob: concatBytes(nonce, ciphertext) };
}

export function decryptFile(blob, key) {
  const nonce = blob.subarray(0, 12);
  const ciphertext = blob.subarray(12);
  return chacha20poly1305(key, nonce).decrypt(ciphertext);
}
