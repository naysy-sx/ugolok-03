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

export function opaqueDTag(masterSecret, kind, logicalKey) {
  const input = utf8ToBytes(`${kind}:${logicalKey}`);
  return bytesToHex(hmac(sha256, masterSecret, input));
}
