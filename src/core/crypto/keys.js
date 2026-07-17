import { schnorr } from "@noble/curves/secp256k1.js";

export function getPublicKey(privateKey) {
  return schnorr.getPublicKey(privateKey);
}
