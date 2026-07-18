import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encryptFile, decryptFile } from "../../core/crypto/file-crypto.js";
import { uploadBlob, downloadBlob } from "../../core/transport/blossom-client.js";
import { validateAttachment } from "./validation.js";

function base64FromBytes(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}

function base64ToBytes(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

function attachmentTypeFromMime(mime) {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return 'file';
}

export async function uploadAttachment(serverUrl, fileBytes, { mime, name }, privateKey, options = {}) {
  validateAttachment({ mime, size: fileBytes.length });
  const { key, blob } = encryptFile(fileBytes);
  const sha256Hex = bytesToHex(sha256(blob));
  const response = await uploadBlob(serverUrl, blob, sha256Hex, privateKey, options);
  return {
    type: attachmentTypeFromMime(mime),
    sha256: response.sha256,
    blossomUrl: serverUrl,
    encryptionKey: base64FromBytes(key),
    mime,
    size: response.size,
    name
  };
}

export async function downloadAttachment({ sha256: expectedSha256, blossomUrl, encryptionKey }, options = {}) {
  const blob = await downloadBlob(blossomUrl, expectedSha256, options);
  const actualSha256 = bytesToHex(sha256(blob));
  if (actualSha256 !== expectedSha256) {
    throw new Error('Blossom-сервер вернул подменённые данные (sha256 не совпадает)');
  }
  const key = base64ToBytes(encryptionKey);
  return decryptFile(blob, key);
}
