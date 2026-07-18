import { sign } from '../../core/crypto/sign.js';
import { encrypt as nip44Encrypt } from '../../core/crypto/nip44.js';
import { wrap as nip59Wrap } from '../../core/crypto/nip59.js';
import { getPublicKey } from '../../core/crypto/keys.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const IDENTITY_POOL_SIZE = 80;
const FOLD_KEY_POOL_SIZE = 100;
const DEFAULT_RATIOS = { profile: 0.1, giftwrap: 0.5, permission: 0.15, channel: 0.25 };

function pick(pool, i) {
	return pool[i % pool.length];
}

// Подпись/шифрование — синхронные CPU-операции; без периодической отдачи
// event loop'у цикл на 5000 фикстур держит main thread занятым одним
// блоком (~15-20с) и браузер не успевает перерисовать даже уже
// выставленный React/Preact-статус. Каждые YIELD_EVERY итераций отдаём
// один тик — не влияет на замеряемую фазу P-SPIKE (генерация в неё не входит).
const YIELD_EVERY = 250;
function yieldToMain() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function randomBytesBase64(byteLength) {
  const array = new Uint8Array(byteLength);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, array));
}

export function makeProfileEvent(privKey, contentByteLength) {
  const eventTemplate = {
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: 'user-' + Math.random().toString(36).substr(2, 5), about: randomBytesBase64(contentByteLength), picture: '' }),
    created_at: Math.floor(Date.now()/1000)
  };
  return sign(eventTemplate, privKey);
}

export function makeGiftWrapEvent(senderPrivKey, recipientPubKeyHex, contentByteLength) {
  const rumorTemplate = { kind: 14, tags: [], content: randomBytesBase64(contentByteLength), created_at: Math.floor(Date.now()/1000) };
  return nip59Wrap(rumorTemplate, senderPrivKey, recipientPubKeyHex);
}

export function makePermissionProxyEvent(privKey, foldKey, contentByteLength) {
  const pubKeyHex = bytesToHex(getPublicKey(privKey));
  const plaintext = JSON.stringify({ subject: foldKey, mask: 1, data: randomBytesBase64(contentByteLength) });
  const encryptedContent = nip44Encrypt(plaintext, privKey, pubKeyHex);
  const eventTemplate = { kind: 30051, tags: [['d', foldKey]], content: encryptedContent, created_at: Math.floor(Date.now()/1000) };
  return sign(eventTemplate, privKey);
}

export function makeChannelProxyEvent(privKey, channelKey, foldKey, contentByteLength) {
  const plaintext = new TextEncoder().encode(randomBytesBase64(contentByteLength));
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = chacha20poly1305(channelKey, nonce).encrypt(plaintext);
  const content = btoa(String.fromCharCode.apply(null, nonce)) + ':' + btoa(String.fromCharCode.apply(null, ciphertext));
  const eventTemplate = { kind: 30061, tags: [['d', foldKey]], content, created_at: Math.floor(Date.now()/1000) };
  return sign(eventTemplate, privKey);
}

export async function generateSyntheticEvents(count, options = {}) {
	const ratios = { ...DEFAULT_RATIOS, ...options };

	const identities = Array.from({ length: IDENTITY_POOL_SIZE }, () => {
		const privKey = crypto.getRandomValues(new Uint8Array(32));
		return { privKey, pubKeyHex: bytesToHex(getPublicKey(privKey)) };
	});
	const permissionFoldKeys = Array.from({ length: FOLD_KEY_POOL_SIZE }, (_, i) => `perm-fold-${i}`);
	const channelFoldKeys = Array.from({ length: FOLD_KEY_POOL_SIZE }, (_, i) => `chan-fold-${i}`);
	const channelKeys = Array.from({ length: 10 }, () => crypto.getRandomValues(new Uint8Array(32)));

	const profileCount = Math.round(count * ratios.profile);
	const giftwrapCount = Math.round(count * ratios.giftwrap);
	const permissionCount = Math.round(count * ratios.permission);
	const channelCount = count - profileCount - giftwrapCount - permissionCount;

	const fixtures = [];

	for (let i = 0; i < profileCount; i++) {
		if (i > 0 && i % YIELD_EVERY === 0) await yieldToMain();
		const identity = pick(identities, i);
		const event = makeProfileEvent(identity.privKey, 300);
		fixtures.push({ event, kindGroup: "profile", foldKey: identity.pubKeyHex });
	}

	// Все gift wrap'ы адресованы ОДНОМУ фиксированному "владельцу" (identities[0]) —
	// как при реальном bootstrap: расшифровывается свой инбокс, не случайные чужие пары.
	// senderPrivKey игнорируется в decrypt-пути, значит отправители могут повторяться свободно.
	const owner = identities[0];
	for (let i = 0; i < giftwrapCount; i++) {
		if (i > 0 && i % YIELD_EVERY === 0) await yieldToMain();
		const sender = pick(identities, i + 1);
		const event = makeGiftWrapEvent(sender.privKey, owner.pubKeyHex, 200 + Math.floor(Math.random() * 600));
		fixtures.push({ event, kindGroup: "giftwrap", foldKey: null });
	}

	// "NIP-44 для себя" (TECH.md §8.2) — правило доступа всегда шифрует и подписывает
	// ВЛАДЕЛЕЦ (тот же "owner", что и получатель giftwrap'ов), не случайный автор:
	// расшифровать self-encrypted содержимое можно только СВОИМ privKey.
	for (let i = 0; i < permissionCount; i++) {
		if (i > 0 && i % YIELD_EVERY === 0) await yieldToMain();
		const foldKey = pick(permissionFoldKeys, i);
		const event = makePermissionProxyEvent(owner.privKey, foldKey, 150);
		fixtures.push({ event, kindGroup: "permission-proxy", foldKey });
	}

	for (let i = 0; i < channelCount; i++) {
		if (i > 0 && i % YIELD_EVERY === 0) await yieldToMain();
		const identity = pick(identities, i);
		const foldKey = pick(channelFoldKeys, i);
		const channelKey = pick(channelKeys, i);
		const event = makeChannelProxyEvent(identity.privKey, channelKey, foldKey, 300 + Math.floor(Math.random() * 1200));
		fixtures.push({ event, kindGroup: "channel-proxy", foldKey, channelKey });
	}

	return { fixtures, giftwrapRecipientPrivKey: owner.privKey };
}
