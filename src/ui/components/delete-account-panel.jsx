import { useState } from "preact/hooks";
import { decryptPrivateKey } from "../../core/crypto/keystore.js";
import { deleteAccountEverywhere } from "../../domain/identity/account-deletion.js";
import { lock } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";

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
			setError("Логин не совпадает — набор символов должен совпадать буквально.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await decryptPrivateKey(password, ownerPubkey); // гейт: бросает на неверном пароле
		} catch {
			setError("Неверный пароль.");
			setBusy(false);
			return;
		}
		try {
			await deleteAccountEverywhere(ownerPubkey, privKey, dbKey, login, publish, BLOSSOM_URL);
			lock();
		} catch (err) {
			setError(err?.message || String(err));
			setBusy(false);
		}
	}

	if (!open) {
		return (
			<button type="button" class="btn--danger" onClick={handleOpen}>
				Удалить аккаунт
			</button>
		);
	}

	return (
		<form class="flow" style={{ "--flow-space": "var(--space-2xs)" }} onSubmit={handleSubmit}>
			<p style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
				Это необратимо. Все ваши данные на этом устройстве (чаты, контакты, каналы, файлы) будут удалены. Отправленные
				вами сообщения и вложения у собеседников — <strong>останутся у них</strong> (отозвать уже доставленное нельзя).
				Если этот же аккаунт открыт на другом устройстве — там ничего не изменится.
			</p>
			<label>
				Введите логин «{login}» для подтверждения
				<input type="text" value={loginInput} onInput={(e) => setLoginInput(e.currentTarget.value)} disabled={busy} required autoComplete="off" />
			</label>
			<label>
				Пароль
				<input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} disabled={busy} required autoComplete="current-password" />
			</label>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			<div class="cluster">
				<button type="submit" class="btn--danger" disabled={busy}>
					{busy ? "Удаление…" : "Удалить безвозвратно"}
				</button>
				<button type="button" class="btn--ghost" onClick={handleCancel} disabled={busy}>
					Отмена
				</button>
			</div>
		</form>
	);
}
