import { useState } from "preact/hooks";
import { decryptMnemonic } from "../../core/crypto/keystore.js";
import MnemonicDisplay from "./mnemonic-display.jsx";
import { t } from "../signals/i18n.js";

export default function MnemonicReveal({ ownerPubkey, hasMnemonic }) {
  const [phrase, setPhrase] = useState(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);

  if (!hasMnemonic) {
    return (
      <p style={{ color: "var(--muted)" }}>
        {t("settings.mnemonicUnavailable")}
      </p>
    );
  }

  const handleShowPhrase = () => setShowForm(true);
  const handleCancel = () => {
    setPassword("");
    setError(null);
    setPhrase(null);
    setShowForm(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const mnemonic = await decryptMnemonic(password, ownerPubkey);
      setPhrase(mnemonic);
      setShowForm(false);
    } catch {
      setError(t("unlock.main.loginForm.wrongPasswordError"));
      setPassword("");
    }
  };

  return (
    <>
      {showForm ? (
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("settings.enterPasswordPlaceholder")}
            required
          />
          <button type="submit">{t("common.confirm")}</button>
          <button type="button" onClick={handleCancel}>{t("common.cancel")}</button>
          {error && (
            <p role="alert" style={{ color: "var(--bad)" }}>
              {error}
            </p>
          )}
        </form>
      ) : phrase ? (
        <>
          <MnemonicDisplay words={phrase.split(" ")} />
          <button type="button" onClick={handleCancel}>{t("settings.hidePhraseButton")}</button>
        </>
      ) : (
        <button type="button" onClick={handleShowPhrase}>{t("settings.showPhraseButton")}</button>
      )}
    </>
  );
}
