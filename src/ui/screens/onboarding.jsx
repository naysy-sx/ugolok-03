import { useState, useEffect } from "preact/hooks";
import { generateMnemonic, validateMnemonic, mnemonicToPrivateKey } from "../../core/crypto/mnemonic.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encryptAndStore } from "../../core/crypto/keystore.js";
import { db } from "../../core/store/database.js";
import { navigate } from "../router.js";
import { decode as nip19Decode, npubEncode } from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import MnemonicDisplay from "../components/mnemonic-display.jsx";

const MIN_PASSWORD_LENGTH = 8;

export default function Onboarding() {
  const [step, setStep] = useState("guard");
  const [mnemonic, setMnemonic] = useState("");
  const [confirmInput, setConfirmInput] = useState("");
  const [importInput, setImportInput] = useState("");
  const [privKey, setPrivKey] = useState(null);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [npub, setNpub] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const existing = await db.table("keystore").get("privkey");
      setStep(existing ? "blocked" : "choose");
    })();
  }, []);

  function chooseVariant(v) {
    setError("");
    if (v === "create") {
      setMnemonic(generateMnemonic());
      setStep("create-generate");
    } else if (v === "import-mnemonic") {
      setStep("import-mnemonic");
    } else if (v === "import-key") {
      setStep("import-key");
    }
  }

  return (
    <main class="center flow" style={{ "--container": "44rem" }}>
      <header class="flow">
        <p class="eyebrow">Уголок</p>
        <h1>Онбординг</h1>
      </header>

      {step === "guard" && (
        <p style={{ color: "var(--muted)" }}>Проверка…</p>
      )}

      {step === "blocked" && (
        <p
          role="alert"
          style={{
            padding: "var(--space-m)",
            background: "var(--surface)",
            borderInlineStart: "3px solid var(--accent)",
          }}
        >
          На этом устройстве уже есть сохранённый ключ. Создание нового
          аккаунта его сотрёт. Эта проверка временная (до этапа 12).
        </p>
      )}

      {step === "choose" && (
        <div class="flow">
          <p>Выберите способ входа:</p>
          <div class="cluster">
            <button type="button" onClick={() => chooseVariant("create")}>
              Создать новый аккаунт
            </button>
            <button type="button" onClick={() => chooseVariant("import-mnemonic")}>
              Войти по мнемонике
            </button>
            <button type="button" onClick={() => chooseVariant("import-key")}>
              Войти по ключу (nsec)
            </button>
          </div>
        </div>
      )}

      {step === "create-generate" && (
        <div class="flow">
          <p>Запишите эти 12 слов в надёжном месте. Это единственный способ восстановить доступ к аккаунту.</p>
          <MnemonicDisplay words={mnemonic.split(" ")} />
          <button
            type="button"
            onClick={() => {
              setConfirmInput("");
              setStep("create-confirm");
            }}
          >
            Я сохранил фразу
          </button>
        </div>
      )}

      {step === "create-confirm" && (
        <div class="flow">
          <p>Введите фразу ещё раз, чтобы подтвердить, что вы её сохранили.</p>
          <label for="confirm-mnemonic">Мнемоническая фраза (12 слов через пробел)</label>
          <textarea
            id="confirm-mnemonic"
            value={confirmInput}
            onInput={(e) => setConfirmInput(e.currentTarget.value)}
          />
          <div class="cluster">
            <button
              type="button"
              onClick={async () => {
                const normalize = (s) => s.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
                if (normalize(confirmInput) !== normalize(mnemonic)) {
                  setError("Фраза не совпадает. Проверьте и попробуйте снова.");
                  return;
                }
                setError("");
                const key = await mnemonicToPrivateKey(mnemonic);
                setPrivKey(key);
                setStep("password");
              }}
            >
              Подтвердить
            </button>
            <button type="button" onClick={() => setStep("create-generate")}>
              Назад
            </button>
          </div>
        </div>
      )}

      {step === "import-mnemonic" && (
        <div class="flow">
          <p>Введите вашу мнемоническую фразу (12 слов через пробел).</p>
          <label for="import-mnemonic">Мнемоническая фраза</label>
          <textarea
            id="import-mnemonic"
            value={importInput}
            onInput={(e) => setImportInput(e.currentTarget.value)}
          />
          <div class="cluster">
            <button
              type="button"
              onClick={async () => {
                const trimmed = importInput.trim();
                if (!validateMnemonic(trimmed)) {
                  setError("Неверная мнемоническая фраза (не проходит проверку контрольной суммы).");
                  return;
                }
                setError("");
                const key = await mnemonicToPrivateKey(trimmed);
                setPrivKey(key);
                setStep("password");
              }}
            >
              Продолжить
            </button>
            <button type="button" onClick={() => setStep("choose")}>
              Назад
            </button>
          </div>
        </div>
      )}

      {step === "import-key" && (
        <div class="flow">
          <p>Введите приватный ключ в формате nsec1... или как hex-строку (64 символа).</p>
          <label for="import-key">Приватный ключ</label>
          <input
            id="import-key"
            type="password"
            value={importInput}
            onInput={(e) => setImportInput(e.currentTarget.value)}
          />
          <div class="cluster">
            <button
              type="button"
              onClick={() => {
                const trimmed = importInput.trim();
                try {
                  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
                    setPrivKey(hexToBytes(trimmed));
                  } else {
                    const decoded = nip19Decode(trimmed);
                    if (decoded.type !== "nsec") {
                      setError("Это не приватный ключ (nsec), а " + decoded.type + ". Проверьте, что вы скопировали.");
                      return;
                    }
                    setPrivKey(decoded.data);
                  }
                  setError("");
                  setStep("password");
                } catch (e) {
                  setError("Не удалось распознать ключ: " + (e?.message || e));
                }
              }}
            >
              Продолжить
            </button>
            <button type="button" onClick={() => setStep("choose")}>
              Назад
            </button>
          </div>
        </div>
      )}

      {step === "password" && (
        <div class="flow">
          <p>Придумайте пароль для шифрования ключа на этом устройстве (минимум {MIN_PASSWORD_LENGTH} символов).</p>
          <label for="password">Пароль</label>
          <input
            id="password"
            type="password"
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
          <label for="password-confirm">Повторите пароль</label>
          <input
            id="password-confirm"
            type="password"
            value={passwordConfirm}
            onInput={(e) => setPasswordConfirm(e.currentTarget.value)}
          />
          <div class="cluster">
            <button
              type="button"
              onClick={async () => {
                if (password.length < MIN_PASSWORD_LENGTH) {
                  setError(`Пароль слишком короткий (минимум ${MIN_PASSWORD_LENGTH} символов).`);
                  return;
                }
                if (password !== passwordConfirm) {
                  setError("Пароли не совпадают.");
                  return;
                }
                setError("");
                await encryptAndStore(privKey, password);
                const pubKey = getPublicKey(privKey);
                setNpub(npubEncode(bytesToHex(pubKey)));
                setStep("done");
              }}
            >
              Сохранить
            </button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div class="flow">
          <p>Готово! Ваш публичный идентификатор:</p>
          <p style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{npub}</p>
          <button type="button" onClick={() => navigate("/main")}>
            Перейти в приложение
          </button>
        </div>
      )}

      {error && (
        <p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
          {error}
        </p>
      )}
    </main>
  );
}
