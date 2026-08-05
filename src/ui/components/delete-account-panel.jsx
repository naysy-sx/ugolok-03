import { useState } from "preact/hooks";
import { decryptPrivateKey } from "../../core/crypto/keystore.js";
import { deleteAccountEverywhere } from "../../domain/identity/account-deletion.js";
import { lock } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { t, errorMessage } from "../signals/i18n.js";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Необратимое действие — пользователь: подтверждение сильнее обычного
// window.confirm (тот же принцип, что GitHub у удаления репозитория):
// повторный ввод логина ЭТОГО аккаунта + пароля. Пароль здесь — ТОЛЬКО
// подтверждение личности (decryptPrivateKey бросает на неверном пароле),
// сама операция использует УЖЕ расшифрованные privKey/dbKey активной
// сессии (переданы пропсами) — заново по паролю ничего не выводится,
// это не отдельный секрет, а гейт "точно вы, не случайный клик".
export default function DeleteAccountPanel({ ownerPubkey, login, privKey, dbKey }) {
	const [open, setOpen] = useState(false);
	const [loginInput, setLoginInput] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	function handleOpen() {
		setOpen(true);
		setLoginInput("");
		setPassword("");
		setError("");
	}

	function handleCancel() {
		setOpen(false);
		setLoginInput("");
		setPassword("");
		setError("");
		setBusy(false);
	}

	async function handleSubmit(e) {
		e.preventDefault();
		if (loginInput !== login) {
			setError(t("settings.deleteAccount.loginMismatchError"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			await decryptPrivateKey(password, ownerPubkey); // гейт: бросает на неверном пароле
		} catch {
			setError(t("unlock.main.loginForm.wrongPasswordError"));
			setBusy(false);
			return;
		}
		try {
			await deleteAccountEverywhere(ownerPubkey, privKey, dbKey, login, publish, BLOSSOM_URL);
			lock();
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	}

	if (!open) {
		return (
			<button type="button" class="btn--ghost btn--danger" onClick={handleOpen}>
				{t("settings.deleteAccount.openButton")}
			</button>
		);
	}

	return (
		<form class="stack" style={{ "--gap": "var(--space-2xs)" }} onSubmit={handleSubmit}>
			<p style={{ color: "var(--bad)" }}>
				{t("settings.deleteAccount.warningBeforeStrong")} <strong>{t("settings.deleteAccount.warningStrong")}</strong> {t("settings.deleteAccount.warningAfterStrong")}
			</p>
			<label>
				{t("settings.deleteAccount.confirmLoginLabel", { login })}
				<input type="text" value={loginInput} onInput={(e) => setLoginInput(e.currentTarget.value)} disabled={busy} required autoComplete="off" />
			</label>
			<label>
				{t("settings.deleteAccount.passwordLabel")}
				<input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} disabled={busy} required autoComplete="current-password" />
			</label>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
				<button type="submit" class="btn--ghost btn--danger" disabled={busy}>
					{busy ? t("settings.deleteAccount.deletingButton") : t("settings.deleteAccount.deletePermanentlyButton")}
				</button>
				<button type="button" class="btn--ghost" onClick={handleCancel} disabled={busy}>
					{t("common.cancel")}
				</button>
			</div>
		</form>
	);
}
