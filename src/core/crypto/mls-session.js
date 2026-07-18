import {
  createGroup as mlsCreateGroup,
  joinGroup as mlsJoinGroup,
  createCommit,
  createApplicationMessage,
  processMessage,
  generateKeyPackage,
  getCiphersuiteImpl,
  defaultCredentialTypes,
  defaultProposalTypes,
  encode,
  decode,
  mlsMessageEncoder,
  mlsMessageDecoder,
  protocolVersions,
  wireformats,
  zeroOutUint8Array,
  mlsExporter,
  clientStateEncoder,
  clientStateDecoder,
} from "ts-mls";
import { getPublicKey } from "./keys.js";

// Выбор ciphersuite и обоснование — DESIGN.md, раздел "Этап 13".
const CIPHERSUITE_NAME = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

// Не unsafeTestingAuthenticationService из ts-mls (та безусловно возвращает true).
// Настоящая проверка биннинга Nostr-подписи — граница вызывающего кода, см. DESIGN.md/CONTRACTS.md.
// Здесь — только структурная проверка формы credential.
// Этап 25 — правка контракта (многоустройственность): identity credential раньше был
// ГОЛЫМ hex pubkey — единственный на identity, поэтому два устройства ОДНОЙ identity
// давали ОДИНАКОВЫЙ credential, и ts-mls (defaultKeyPackageEqualityConfig, сравнение по
// encode(credential) при несовпадении signaturePublicKey) отклонял добавление второго
// устройства как "уже существующего участника" — найдено тестами devices.js, не домысел.
// Теперь identity = "${nostrPubkeyHex}:${deviceId}" — каждое устройство ЧЕСТНО другой
// MLS-участник (сохраняет защиту ts-mls от настоящих дублей — тот же KeyPackage дважды
// по-прежнему отклоняется, см. addMember: мусорные байты и повторный Add теста этапа 13).
const CREDENTIAL_IDENTITY_RE = /^([0-9a-f]{64}):(.+)$/;

function encodeCredentialIdentity(nostrPubkeyHex, deviceId) {
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new Error("mls-session: deviceId обязателен и не может быть пустой строкой");
  }
  return new TextEncoder().encode(`${nostrPubkeyHex}:${deviceId}`);
}

const nostrCredentialAuthService = {
  async validateCredential(credential) {
    if (credential.credentialType !== defaultCredentialTypes.basic) return false;
    const identity = new TextDecoder().decode(credential.identity);
    return CREDENTIAL_IDENTITY_RE.test(identity);
  },
};

let cachedImpl = null;
async function getImpl() {
  if (!cachedImpl) cachedImpl = await getCiphersuiteImpl(CIPHERSUITE_NAME);
  return cachedImpl;
}

async function getContext() {
  const cipherSuite = await getImpl();
  return { cipherSuite, authService: nostrCredentialAuthService };
}

function assertNostrPubkeyHex(nostrPubkeyHex) {
  if (!HEX_PUBKEY_RE.test(nostrPubkeyHex)) {
    throw new Error("mls-session: nostrPubkeyHex должен быть 64-символьной hex-строкой");
  }
}

function decodeKeyPackage(wireBytes) {
  const decoded = decode(mlsMessageDecoder, wireBytes);
  if (!decoded || decoded.wireformat !== wireformats.mls_key_package) {
    throw new Error("mls-session: ожидался KeyPackage, получен другой формат сообщения");
  }
  return decoded.keyPackage;
}

function decodeWelcome(wireBytes) {
  const decoded = decode(mlsMessageDecoder, wireBytes);
  if (!decoded || decoded.wireformat !== wireformats.mls_welcome) {
    throw new Error("mls-session: ожидался Welcome, получен другой формат сообщения");
  }
  return decoded.welcome;
}

function decodeGroupMessage(wireBytes) {
  const decoded = decode(mlsMessageDecoder, wireBytes);
  if (!decoded || (decoded.wireformat !== wireformats.mls_private_message && decoded.wireformat !== wireformats.mls_public_message)) {
    throw new Error("mls-session: ожидалось сообщение группы (private/public), получен другой формат");
  }
  return decoded;
}

export async function createOwnKeyPackage(nostrPubkeyHex, deviceId) {
  assertNostrPubkeyHex(nostrPubkeyHex);
  const cipherSuite = await getImpl();
  const credential = {
    credentialType: defaultCredentialTypes.basic,
    identity: encodeCredentialIdentity(nostrPubkeyHex, deviceId),
  };
  const { publicPackage, privatePackage } = await generateKeyPackage({ credential, cipherSuite });
  const wireBytes = encode(mlsMessageEncoder, {
    keyPackage: publicPackage,
    wireformat: wireformats.mls_key_package,
    version: protocolVersions.mls10,
  });
  return { publicPackage, privatePackage, wireBytes };
}

export async function createGroup(nostrPubkeyHex, ownKeyPackage, groupIdBytes) {
  assertNostrPubkeyHex(nostrPubkeyHex);
  const context = await getContext();
  return mlsCreateGroup({
    context,
    groupId: groupIdBytes,
    keyPackage: ownKeyPackage.publicPackage,
    privateKeyPackage: ownKeyPackage.privatePackage,
  });
}

export async function addMember(sessionState, theirKeyPackageWireBytes) {
  const context = await getContext();
  const theirKeyPackage = decodeKeyPackage(theirKeyPackageWireBytes);
  const addProposal = { proposalType: defaultProposalTypes.add, add: { keyPackage: theirKeyPackage } };

  // ratchetTreeExtension:true — обязательное расширение NIP-EE ("ratchet_tree"),
  // проверено вживую: делает welcome самодостаточным (joinGroup не требует отдельного дерева).
  let commitResult;
  try {
    commitResult = await createCommit({
      context,
      state: sessionState,
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
    });
    if (!commitResult.welcome) {
      throw new Error("mls-session: commit не произвёл welcome для нового участника");
    }
    return {
      newSessionState: commitResult.newState,
      welcomeWireBytes: encode(mlsMessageEncoder, commitResult.welcome),
      commitWireBytes: encode(mlsMessageEncoder, commitResult.commit),
    };
  } finally {
    // SM-1: одноразовые ключи commit'а не покидают эту функцию неочищенными,
    // независимо от того, на каком шаге (createCommit/encode/проверка welcome) произошла ошибка.
    commitResult?.consumed.forEach(zeroOutUint8Array);
  }
}

export async function joinFromWelcome(ownKeyPackage, welcomeWireBytes) {
  const context = await getContext();
  const welcome = decodeWelcome(welcomeWireBytes);
  return mlsJoinGroup({
    context,
    welcome,
    keyPackage: ownKeyPackage.publicPackage,
    privateKeys: ownKeyPackage.privatePackage,
  });
}

export async function encryptApplicationMessage(sessionState, message) {
  const context = await getContext();
  let sendResult;
  try {
    sendResult = await createApplicationMessage({ context, state: sessionState, message });
    return {
      newSessionState: sendResult.newState,
      wireBytes: encode(mlsMessageEncoder, sendResult.message),
    };
  } finally {
    // SM-1
    sendResult?.consumed.forEach(zeroOutUint8Array);
  }
}

export async function decryptApplicationMessage(sessionState, wireBytes) {
  const context = await getContext();
  const decoded = decodeGroupMessage(wireBytes);
  let result;
  try {
    result = await processMessage({ context, state: sessionState, message: decoded });
    if (result.kind === "applicationMessage") {
      return { newSessionState: result.newState, message: result.message };
    }
    // proposal/commit от другого участника — состояние продвинуто, прикладного сообщения нет
    return { newSessionState: result.newState, kind: "control" };
  } finally {
    // SM-1
    result?.consumed.forEach(zeroOutUint8Array);
  }
}

export async function deriveNostrEnvelopeKeys(sessionState) {
  const cipherSuite = await getImpl();
  // label="nostr", context=пусто, length=32 — фиксировано по NIP-EE, не параметризуется намеренно.
  const privateKey = await mlsExporter(sessionState.keySchedule.exporterSecret, "nostr", new Uint8Array(0), 32, cipherSuite);
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function serializeState(sessionState) {
  return encode(clientStateEncoder, sessionState);
}

export function deserializeState(bytes) {
  return decode(clientStateDecoder, bytes);
}
