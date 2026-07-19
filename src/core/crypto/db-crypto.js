import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// Найдено реальным использованием (этап 39): голый JSON.stringify/parse ТЕРЯЕТ
// Uint8Array-тип (сериализует как {"0":1,"1":2,...} — обычный объект с числовыми
// ключами), а materialized views вроде mlsGroups.state/ownKeyPackage.wireBytes —
// бинарные Uint8Array, иногда ВЛОЖЕННЫЕ внутрь объекта (ts-mls's KeyPackage).
// replacer/reviver вызываются JSON рекурсивно на КАЖДОЕ значение дерева (не
// только top-level), поэтому корректно ловят Uint8Array на любой глубине.
function replacer(key, value) {
  if (value instanceof Uint8Array) {
    return { __u8__: btoa(String.fromCharCode.apply(null, value)) };
  }
  // typeof value === "bigint" никогда не проходит через JSON.stringify(replacer)
  // напрямую (BigInt не сериализуем в принципе) — ловим его ДО этого, через
  // toJSON-подобный трюк не получится, поэтому bigint отлавливается снаружи,
  // см. replaceBigInt ниже, применяемый рекурсивно перед JSON.stringify.
  return value;
}

function reviver(key, value) {
  if (value && typeof value === "object" && typeof value.__u8__ === "string") {
    return Uint8Array.from(atob(value.__u8__), (c) => c.charCodeAt(0));
  }
  if (value && typeof value === "object" && typeof value.__bigint__ === "string") {
    return BigInt(value.__bigint__);
  }
  return value;
}

// JSON.stringify's replacer НИКОГДА не вызывается с value типа bigint напрямую —
// движок бросает TypeError ДО того, как отдать управление replacer'у (в отличие
// от Uint8Array, для которого replacer успевает вмешаться). Поэтому BigInt
// заменяется рекурсивным обходом ДО JSON.stringify, не внутри него.
function replaceBigIntDeep(value) {
  if (typeof value === "bigint") return { __bigint__: value.toString() };
  if (Array.isArray(value)) return value.map(replaceBigIntDeep);
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceBigIntDeep(v);
    return out;
  }
  return value;
}

export function encryptRow(value, dbKey) {
  const plaintext = new TextEncoder().encode(JSON.stringify(replaceBigIntDeep(value), replacer));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = chacha20poly1305(dbKey, nonce).encrypt(plaintext);
  return { nonce, ciphertext };
}

export function decryptRow(encrypted, dbKey) {
  const plaintext = chacha20poly1305(dbKey, encrypted.nonce).decrypt(encrypted.ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext), reviver);
}
