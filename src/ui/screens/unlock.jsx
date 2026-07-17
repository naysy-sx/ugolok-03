import { useState, useEffect } from "preact/hooks";
import { decryptPrivateKey, listAccounts } from "../../core/crypto/keystore.js";
import { login, setRememberedAccountId, getRememberedAccountId } from "../signals/auth.js";
import { navigate } from "../router.js";

export default function Unlock() {
	const [loading, setLoading] = useState(true);
	const [accounts, setAccounts] = useState([]);
	const [selectedAccountId, setSelectedAccountId] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		(async () => {
			const list = await listAccounts();
			setAccounts(list);
			const remembered = getRememberedAccountId();
			const match = list.find((a) => a.id === remembered);
			setSelectedAccountId(match ? match.id : (list[0]?.id ?? ""));
			setLoading(false);
		})();
	}, []);

	async function handleSubmit(e) {
		e.preventDefault();
		if (!selectedAccountId) {
			setError("Выберите аккаунт.");
			return;
		}
		try {
			const privKey = await decryptPrivateKey(password, selectedAccountId);
			const account = accounts.find((a) => a.id === selectedAccountId);
			login(selectedAccountId, account?.login ?? "", privKey);
			setRememberedAccountId(selectedAccountId);
			navigate("/main");
		} catch (err) {
			setError("Неверный пароль.");
		}
	}

	return (
		<main class="center flow" style={{ "--container": "44rem" }}>
			<header class="flow">
				<p class="eyebrow">Уголок</p>
				<h1>Разблокировка</h1>
			</header>

			{loading && <p style={{ color: "var(--muted)" }}>Проверка…</p>}

			{!loading && accounts.length === 0 && (
				<div class="flow">
					<p style={{ color: "var(--muted)" }}>На этом устройстве ещё нет ни одного аккаунта.</p>
					<button type="button" onClick={() => navigate("/onboarding")}>
						Перейти к регистрации
					</button>
				</div>
			)}

			{!loading && accounts.length > 0 && (
				<form class="flow" onSubmit={handleSubmit}>
					{accounts.length > 1 && (
						<fieldset class="flow">
							<legend>Аккаунт</legend>
							<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
								{accounts.map((acc) => (
									<li key={acc.id}>
										<label>
											<input
												type="radio"
												name="account"
												checked={selectedAccountId === acc.id}
												onChange={() => setSelectedAccountId(acc.id)}
											/>{" "}
											{acc.login || acc.id.slice(0, 16) + "…"}
										</label>
									</li>
								))}
							</ul>
						</fieldset>
					)}
					{accounts.length === 1 && (
						<p>
							Аккаунт: <strong>{accounts[0].login || accounts[0].id.slice(0, 16) + "…"}</strong>
						</p>
					)}
					<label for="unlock-password">Пароль</label>
					<input
						id="unlock-password"
						type="password"
						autocomplete="current-password"
						value={password}
						onInput={(e) => setPassword(e.currentTarget.value)}
					/>
					<button type="submit">Войти</button>
				</form>
			)}

			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<p>
				<button
					type="button"
					onClick={() => navigate("/onboarding")}
					style={{ backgroundColor: "transparent", color: "var(--accent)", border: 0, textDecorationLine: "underline", padding: 0 }}
				>
					Другой способ входа
				</button>
			</p>
		</main>
	);
}
