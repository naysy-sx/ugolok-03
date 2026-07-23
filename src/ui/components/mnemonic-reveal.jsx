import { useState } from "preact/hooks";
import { decryptMnemonic } from "../../core/crypto/keystore.js";
import MnemonicDisplay from "./mnemonic-display.jsx";

export default function MnemonicReveal({ ownerPubkey, hasMnemonic }) {
  const [phrase, setPhrase] = useState(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);

  if (!hasMnemonic) {
    return (
      <p style={{ color: "var(--muted)" }}>
        Для этого аккаунта фраза восстановления недоступна.
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
      setError("Неверный пароль.");
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
            placeholder="Введите пароль"
            required
          />
          <button type="submit">Подтвердить</button>
          <button type="button" onClick={handleCancel}>Отмена</button>
          {error && (
            <p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
              {error}
            </p>
          )}
        </form>
      ) : phrase ? (
        <>
          <MnemonicDisplay words={phrase.split(" ")} />
          <button type="button" onClick={handleCancel}>Скрыть</button>
        </>
      ) : (
        <button type="button" onClick={handleShowPhrase}>Показать фразу</button>
      )}
    </>
  );
}
