import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";

export function generateMnemonic() {
  return bip39.generateMnemonic(wordlist, 128);
}

export function validateMnemonic(mnemonic) {
  return bip39.validateMnemonic(mnemonic, wordlist);
}

export async function mnemonicToPrivateKey(mnemonic) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive("m/44'/1237'/0'/0/0");
  return child.privateKey;
}
