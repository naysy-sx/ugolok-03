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
import { ed25519 } from "@noble/curves/ed25519.js";
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

// Найдено живьём (Android/Capacitor, эмулятор, Э4 ТЗ-NATIVE-APPS, 2026-09-28):
// WebView сообщает crypto.subtle как определённый (не undefined), но
// generateKey("Ed25519", ...) бросает "NotSupportedError: Unrecognized name" —
// ts-mls's makeNobleSignatureImpl проверяет только НАЛИЧИЕ subtle, не его
// реальную поддержку конкретного алгоритма, и уходит в этот путь безусловно.
// Раньше это выглядело как бесконечное зависание на "Публикация ключа и
// профиля…" — publish() ТАЙМАУТИТ за 8с (publisher.js), но сам keygen()
// не имеет срока вовсе и ничего не бросает — просто вечно ждёт промис,
// который браузер никогда не резолвит и не реджектит для неподдерживаемого
// алгоритма на некоторых сборках WebView (эмпирически — сама генерация
// РЕДЖЕКТИТСЯ мгновенно; зависание было в СЛЕДУЮЩЕЙ строке кода вызывающего
// приложения, которая никогда не выполнялась, потому что await так и не
// вернул управление — см. PROCESS-DOCS/NATIVE/PROGRESS.md, Э4).
// X25519 (HPKE KEM) на той же сборке работает нормально — подмена только
// подписи, остального (kdf/hash/aead/hpke) не касается.
//
// Пробуем НАТИВНУЮ реализацию ОДИН раз (полный round-trip keygen+sign+verify,
// не только keygen — некоторые платформы теоретически могут поддержать одно,
// не другое) и кэшируем результат. Если платформа справляется — поведение
// НЕ МЕНЯЕТСЯ вообще (те же байты формата PKCS8 в signKey, что и раньше,
// сохранённые identity на проде это уже используют — менять формат безусловно
// для ВСЕХ платформ сломало бы подпись уже созданных на web/desktop identity,
// т.к. noble ждёт сырые 32 байта, а subtle отдаёт PKCS8). Один лишний
// keygen на старте сессии (кэшируется, не на каждый KeyPackage) — цена
// незначительна на платформах, где subtle и так работает.
function makeNobleEd25519Signature() {
  return {
    async sign(signKey, message) {
      return ed25519.sign(message, signKey);
    },
    async verify(publicKey, message, signature) {
      return ed25519.verify(signature, message, publicKey);
    },
    async keygen() {
      const signKey = ed25519.utils.randomSecretKey();
      return { signKey, publicKey: ed25519.getPublicKey(signKey) };
    },
  };
}

async function withEd25519Fallback(nativeSignature) {
  try {
    const probeKeys = await nativeSignature.keygen();
    const probeMessage = new TextEncoder().encode("ugolok-ed25519-capability-probe");
    const probeSignature = await nativeSignature.sign(probeKeys.signKey, probeMessage);
    const verified = await nativeSignature.verify(probeKeys.publicKey, probeMessage, probeSignature);
    if (!verified) throw new Error("round-trip verify провалился");
    return nativeSignature;
  } catch (err) {
    console.warn(`mls-session: нативный Ed25519 (WebCrypto) недоступен на этой платформе, использую @noble/curves: ${err?.message ?? err}`);
    return makeNobleEd25519Signature();
  }
}

let cachedImpl = null;
async function getImpl() {
  if (!cachedImpl) {
    const impl = await getCiphersuiteImpl(CIPHERSUITE_NAME);
    impl.signature = await withEd25519Fallback(impl.signature);
    cachedImpl = impl;
  }
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

// Этап 72 — множественное добавление ОДНИМ commit'ом: N add-proposals, ОДИН
// welcome, из которого каждое добавленное устройство извлекает СВОИ секреты
// независимо (штатное свойство MLS Welcome, не костыль). Нужна для
// детерминированного установления 1:1-чата сразу со всеми известными
// устройствами контакта (PROCESS-DOCS/DESIGN.md, "Этап 72") — addMember
// (один участник) не трогается, остаётся для реактивной досинхронизации.
export async function addMembers(sessionState, theirKeyPackagesWireBytesArray) {
  if (theirKeyPackagesWireBytesArray.length === 0) {
    throw new Error('mls-session: addMembers требует хотя бы один KeyPackage');
  }

  const context = await getContext();
  const addProposals = theirKeyPackagesWireBytesArray.map((wireBytes) => ({
    proposalType: defaultProposalTypes.add,
    add: { keyPackage: decodeKeyPackage(wireBytes) },
  }));

  let commitResult;
  try {
    commitResult = await createCommit({
      context,
      state: sessionState,
      extraProposals: addProposals,
      ratchetTreeExtension: true,
    });
    if (!commitResult.welcome) {
      throw new Error('mls-session: commit не произвёл welcome для новых участников');
    }
    return {
      newSessionState: commitResult.newState,
      welcomeWireBytes: encode(mlsMessageEncoder, commitResult.welcome),
      commitWireBytes: encode(mlsMessageEncoder, commitResult.commit),
    };
  } finally {
    // SM-1
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
