// Сеть для дерева файлов — синхронизация СВОИХ устройств (CONTRACTS.md/
// DESIGN.md, этап 53 И5, задача 5.1). По образцу domain/settings/
// ui-settings.js's buildUiSettingsEvent/parseUiSettingsEvent — тот же
// приём (NIP-44 "себе"), но content — МАССИВ операций (Op[]), не единый
// объект состояния: дерево синхронизируется журналом, не снимком.
import { sign } from "../../core/crypto/sign.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "../../core/crypto/nip44.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// regular kind (не replaceable/ephemeral) — журнал операций накапливается,
// а не заменяется последней версией; 3007 — первый свободный в блоке,
// проверенном И0 (CONTRACTS.md, этап 53).
export const KIND_FILES_OP = 3007;

export function buildFilesLogEvent(privKey, ops, createdAt = Math.floor(Date.now() / 1000)) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const content = nip44Encrypt(JSON.stringify(ops), privKey, ownPubHex);
	return sign({ kind: KIND_FILES_OP, content, tags: [], created_at: createdAt }, privKey);
}

export function parseFilesLogEvent(event, privKey) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
	return JSON.parse(plaintext);
}
