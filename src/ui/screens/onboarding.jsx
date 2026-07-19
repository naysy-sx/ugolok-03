import { useState, useEffect } from "preact/hooks";
import { generateMnemonic, validateMnemonic, mnemonicToPrivateKey } from "../../core/crypto/mnemonic.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encryptAndStore, decryptPrivateKey, listAccounts } from "../../core/crypto/keystore.js";
import { resetLocalDatabase } from "../../core/store/database.js";
import { navigate } from "../router.js";
import { login, setRememberedAccountId } from "../signals/auth.js";
import { decode as nip19Decode, npubEncode } from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import MnemonicDisplay from "../components/mnemonic-display.jsx";

const MIN_PASSWORD_LENGTH = 8;

export default function Onboarding() {
	const [step, setStep] = useState("loading");
	const [authTab, setAuthTab] = useState("register");
	const [accounts, setAccounts] = useState([]);
	const [selectedAccountId, setSelectedAccountId] = useState("");
	const [loginPassword, setLoginPassword] = useState("");

	const [regLogin, setRegLogin] = useState("");
	const [regPassword, setRegPassword] = useState("");
	const [regPasswordConfirm, setRegPasswordConfirm] = useState("");

	const [mnemonic, setMnemonic] = useState("");
	const [confirmInput, setConfirmInput] = useState("");
	const [importInput, setImportInput] = useState("");
	const [privKey, setPrivKey] = useState(null);
	const [advLogin, setAdvLogin] = useState("");
	const [password, setPassword] = useState("");
	const [passwordConfirm, setPasswordConfirm] = useState("");

	const [npub, setNpub] = useState("");
	const [isQuickRegister, setIsQuickRegister] = useState(false);
	const [pendingLogin, setPendingLogin] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		(async () => {
			try {
				const list = await listAccounts();
				setAccounts(list);
				if (list.length > 0) setSelectedAccountId(list[0].id);
				setAuthTab(list.length > 0 ? "login" : "register");
				setStep("main");
			} catch {
				// Дев-стадия: несовместимая со старой схемой локальная база (см. database.js,
				// resetLocalDatabase) — без этого шаг остался бы на "Проверка…" навсегда.
				setStep("db-error");
			}
		})();
	}, []);

	async function handleResetDatabase() {
		await resetLocalDatabase();
		location.reload();
	}

	async function handleRegisterSubmit(e) {
		e.preventDefault();
		if (!regLogin.trim()) {
			setError("Введите логин.");
			return;
		}
		if (regPassword.length < MIN_PASSWORD_LENGTH) {
			setError(`Пароль слишком короткий (минимум ${MIN_PASSWORD_LENGTH} символов).`);
			return;
		}
		if (regPassword !== regPasswordConfirm) {
			setError("Пароли не совпадают.");
			return;
		}
		setError("");
		const generated = generateMnemonic();
		const key = await mnemonicToPrivateKey(generated);
		const id = bytesToHex(getPublicKey(key));
		await encryptAndStore(key, regPassword, id, { login: regLogin.trim() });
		setPrivKey(key);
		setPendingLogin(regLogin.trim());
		setNpub(npubEncode(id));
		setIsQuickRegister(true);
		setStep("done");
	}

	async function handleLoginSubmit(e) {
		e.preventDefault();
		if (!selectedAccountId) {
			setError("Выберите аккаунт.");
			return;
		}
		try {
			const key = await decryptPrivateKey(loginPassword, selectedAccountId);
			const account = accounts.find((a) => a.id === selectedAccountId);
			login(selectedAccountId, account?.login ?? "", key);
			setRememberedAccountId(selectedAccountId);
			navigate("/main");
		} catch (err) {
			setError("Неверный пароль.");
		}
	}

	function openAdvanced(kind) {
		setError("");
		setAdvLogin("");
		setPassword("");
		setPasswordConfirm("");
		if (kind === "create") {
			setMnemonic(generateMnemonic());
			setStep("create-generate");
		} else if (kind === "import-mnemonic") {
			setImportInput("");
			setStep("import-mnemonic");
		} else if (kind === "import-key") {
			setImportInput("");
			setStep("import-key");
		}
	}

	async function handleAdvancedPasswordSubmit(e) {
		e.preventDefault();
		if (!advLogin.trim()) {
			setError("Введите логин.");
			return;
		}
		if (password.length < MIN_PASSWORD_LENGTH) {
			setError(`Пароль слишком короткий (минимум ${MIN_PASSWORD_LENGTH} символов).`);
			return;
		}
		if (password !== passwordConfirm) {
			setError("Пароли не совпадают.");
			return;
		}
		setError("");
		const id = bytesToHex(getPublicKey(privKey));
		await encryptAndStore(privKey, password, id, { login: advLogin.trim() });
		setPendingLogin(advLogin.trim());
		setNpub(npubEncode(id));
		setIsQuickRegister(false);
		setStep("done");
	}

	return (
		<main class="center flow" style={{ "--container": "44rem" }}>
			<header class="flow">
				<p class="eyebrow">Уголок</p>
				<h1>Вход и регистрация</h1>
			</header>

			{step === "loading" && (
				<p style={{ color: "var(--muted)" }}>Проверка…</p>
			)}

			{step === "db-error" && (
				<div class="flow">
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						Не удалось открыть локальную базу данных — возможно, она осталась в
						несовместимом формате после обновления приложения.
					</p>
					<p style={{ color: "var(--muted)" }}>
						Это стирает все локальные данные на этом устройстве (аккаунты,
						переписку, каналы) и потребует повторного входа или регистрации.
					</p>
					<button type="button" onClick={handleResetDatabase}>
						Очистить локальные данные и начать заново
					</button>
				</div>
			)}

			{step === "main" && (
				<div class="flow">
					<div class="cluster" role="tablist" aria-label="Вход и регистрация">
						<button
							type="button"
							role="tab"
							aria-selected={authTab === "register"}
							style={
								authTab === "register"
									? null
									: { backgroundColor: "transparent", color: "var(--fg)", borderColor: "var(--border)" }
							}
							onClick={() => {
								setError("");
								setAuthTab("register");
							}}
						>
							Регистрация
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={authTab === "login"}
							style={
								authTab === "login"
									? null
									: { backgroundColor: "transparent", color: "var(--fg)", borderColor: "var(--border)" }
							}
							onClick={() => {
								setError("");
								setAuthTab("login");
							}}
						>
							Вход
						</button>
					</div>

					{authTab === "register" && (
						<div class="flow" role="tabpanel">
							<form class="flow" onSubmit={handleRegisterSubmit}>
								<fieldset class="flow">
									<legend>Регистрация</legend>
									<label for="reg-login">Логин</label>
									<input
										id="reg-login"
										type="text"
										autocomplete="username"
										value={regLogin}
										onInput={(e) => setRegLogin(e.currentTarget.value)}
									/>
									<label for="reg-password">Пароль</label>
									<input
										id="reg-password"
										type="password"
										autocomplete="new-password"
										value={regPassword}
										onInput={(e) => setRegPassword(e.currentTarget.value)}
									/>
									<label for="reg-password-confirm">Повторите пароль</label>
									<input
										id="reg-password-confirm"
										type="password"
										autocomplete="new-password"
										value={regPasswordConfirm}
										onInput={(e) => setRegPasswordConfirm(e.currentTarget.value)}
									/>
								</fieldset>
								<button type="submit">Зарегистрироваться</button>
							</form>

							<details>
								<summary>Другие способы (для опытных пользователей)</summary>
								<div class="cluster" style={{ marginBlockStart: "var(--space-s)" }}>
									<button type="button" onClick={() => openAdvanced("create")}>
										Создать с показом фразы восстановления
									</button>
									<button type="button" onClick={() => openAdvanced("import-mnemonic")}>
										Войти по мнемонике
									</button>
									<button type="button" onClick={() => openAdvanced("import-key")}>
										Войти по ключу (nsec)
									</button>
								</div>
							</details>
						</div>
					)}

					{authTab === "login" && (
						<form class="flow" role="tabpanel" onSubmit={handleLoginSubmit}>
							{accounts.length === 0 && (
								<p style={{ color: "var(--muted)" }}>
									На этом устройстве ещё нет ни одного аккаунта. Перейдите на вкладку "Регистрация".
								</p>
							)}
							{accounts.length > 0 && (
								<>
									<fieldset class="flow">
										<legend>Выберите аккаунт</legend>
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
									<label for="login-password">Пароль</label>
									<input
										id="login-password"
										type="password"
										autocomplete="current-password"
										value={loginPassword}
										onInput={(e) => setLoginPassword(e.currentTarget.value)}
									/>
									<button type="submit">Войти</button>
								</>
							)}
						</form>
					)}
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
								setStep("advanced-password");
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
								setStep("advanced-password");
							}}
						>
							Продолжить
						</button>
						<button type="button" onClick={() => setStep("main")}>
							Назад
						</button>
					</div>
				</div>
			)}

			{step === "import-key" && (
				<div class="flow">
					<p>Введите приватный ключ в формате nsec1... или как hex-строку (64 символа).</p>
					<p style={{ color: "var(--muted)" }}>
						Приватный ключ — секретная строка, которая даёт полный доступ к
						вашему аккаунту. Никогда и никому её не показывайте. В формате{" "}
						<code>nsec</code> (NIP-19, bech32) она начинается с{" "}
						<code>nsec1</code> и выглядит примерно так:
					</p>
					<p style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
						<code>nsec1zh0anykm9v3grv0wmw56pauv3yks03pz8jdgj4agcyg85xqumq3qn8lrhz</code>
						<br />
						<small style={{ color: "var(--muted)" }}>(это лишь пример формата, не настоящий ключ)</small>
					</p>
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
									setStep("advanced-password");
								} catch (e) {
									setError("Не удалось распознать ключ: " + (e?.message || e));
								}
							}}
						>
							Продолжить
						</button>
						<button type="button" onClick={() => setStep("main")}>
							Назад
						</button>
					</div>
				</div>
			)}

			{step === "advanced-password" && (
				<form class="flow" onSubmit={handleAdvancedPasswordSubmit}>
					<fieldset class="flow">
						<legend>Данные аккаунта</legend>
						<label for="adv-login">Логин</label>
						<input
							id="adv-login"
							type="text"
							autocomplete="username"
							value={advLogin}
							onInput={(e) => setAdvLogin(e.currentTarget.value)}
						/>
						<label for="adv-password">Пароль (минимум {MIN_PASSWORD_LENGTH} символов)</label>
						<input
							id="adv-password"
							type="password"
							autocomplete="new-password"
							value={password}
							onInput={(e) => setPassword(e.currentTarget.value)}
						/>
						<label for="adv-password-confirm">Повторите пароль</label>
						<input
							id="adv-password-confirm"
							type="password"
							autocomplete="new-password"
							value={passwordConfirm}
							onInput={(e) => setPasswordConfirm(e.currentTarget.value)}
						/>
					</fieldset>
					<button type="submit">Сохранить</button>
				</form>
			)}

			{step === "done" && (
				<div class="flow">
					<p>Готово! Ваш публичный идентификатор:</p>
					<p style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{npub}</p>
					{isQuickRegister && (
						<p
							role="alert"
							style={{
								padding: "var(--space-m)",
								background: "var(--surface)",
								borderInlineStart: "3px solid var(--accent)",
							}}
						>
							Быстрая регистрация: секретная фраза восстановления не
							показывалась и нигде не сохранялась вами. Если это
							устройство или браузерное хранилище будет потеряно —
							восстановить доступ к аккаунту будет нечем. Показать фразу
							для резервной копии можно будет позже в настройках.
						</p>
					)}
					<button
						type="button"
						onClick={() => {
							const id = bytesToHex(getPublicKey(privKey));
							login(id, pendingLogin, privKey);
							setRememberedAccountId(id);
							navigate("/main");
						}}
					>
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
