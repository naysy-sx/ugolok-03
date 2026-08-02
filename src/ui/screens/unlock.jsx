import { useState, useEffect } from "preact/hooks";
import { generateMnemonic, validateMnemonic, mnemonicToPrivateKey } from "../../core/crypto/mnemonic.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encryptAndStore, decryptPrivateKey, listAccounts } from "../../core/crypto/keystore.js";
import { resetLocalDatabase } from "../../core/store/database.js";
import { navigate } from "../router.js";
import { login, setRememberedAccountId, getRememberedAccountId } from "../signals/auth.js";
import { decode as nip19Decode, npubEncode } from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import MnemonicDisplay from "../components/mnemonic-display.jsx";
import AccountAvatar from "../components/account-avatar.jsx";
import HelpContent from "../components/help-content.jsx";
import { t } from "../signals/i18n.js";

const MIN_PASSWORD_LENGTH = 8;

// Стартовый экран — первое, что видит и гость, и вернувшийся пользователь (единый
// экран по решению пользователя: раньше это были два разных роута/компонента,
// Unlock и Onboarding, теперь слиты в один — вход, регистрация и "другие способы"
// живут виджетами одной страницы, без перехода между роутами).
export default function Unlock() {
	const [step, setStep] = useState("loading");
	const [accounts, setAccounts] = useState([]);

	// Какой раздел показан в <main> стартовой страницы (не связано с "step" —
	// тот управляет всем экраном целиком: логин/регистрация/раскрытие мнемоники
	// и т.п., этот — только контентом <main> ВНУТРИ step === "main").
	// "temp-chat" — пока заглушка (пользователь: "отдельная масштабная задача"),
	// "help" — переиспользует ту же справку, что и залогиненный раздел
	// (см. components/help-content.jsx).
	const [mainView, setMainView] = useState("home");

	// Какой из виджетов сейчас раскрыт — взаимоисключающе (тот же принцип, что
	// showRegisterForm()/openLoginFor() в исходном прототипе: открытие одного
	// закрывает другой). null у openLoginForId — виджет входа свёрнут.
	const [openLoginForId, setOpenLoginForId] = useState(null);
	const [registerBoxOpen, setRegisterBoxOpen] = useState(false);
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
				if (list.length === 0) {
					// Гость без единого локального аккаунта — сразу открыть форму
					// регистрации, не заставлять искать кнопку в пустом виджете.
					setRegisterBoxOpen(true);
				} else {
					// Вернувшийся пользователь — сразу раскрыть форму входа для
					// запомненного аккаунта (тот же приём, что старый Unlock).
					const remembered = getRememberedAccountId();
					const match = list.find((a) => a.id === remembered);
					setOpenLoginForId(match ? match.id : list[0].id);
				}
				setStep("main");
			} catch {
				// Дев-стадия: несовместимая со старой схемой локальная база (см. database.js,
				// resetLocalDatabase) — без этого экран остался бы на "Проверка…" навсегда.
				setStep("db-error");
			}
		})();
	}, []);

	async function handleResetDatabase() {
		await resetLocalDatabase();
		location.reload();
	}

	function openLoginFor(id) {
		setError("");
		setLoginPassword("");
		setRegisterBoxOpen(false);
		setOpenLoginForId(id);
	}

	function openRegisterBox() {
		setError("");
		setRegLogin("");
		setRegPassword("");
		setRegPasswordConfirm("");
		setOpenLoginForId(null);
		setRegisterBoxOpen(true);
	}

	async function handleLoginSubmit(e) {
		e.preventDefault();
		if (!openLoginForId) {
			setError(t("unlock.main.loginForm.selectAccountError"));
			return;
		}
		try {
			const key = await decryptPrivateKey(loginPassword, openLoginForId);
			const account = accounts.find((a) => a.id === openLoginForId);
			login(openLoginForId, account?.login ?? "", key);
			setRememberedAccountId(openLoginForId);
			navigate("/main");
		} catch {
			setError(t("unlock.main.loginForm.wrongPasswordError"));
		}
	}

	async function handleRegisterSubmit(e) {
		e.preventDefault();
		if (!regLogin.trim()) {
			setError(t("unlock.main.registerBox.loginRequiredError"));
			return;
		}
		if (regPassword.length < MIN_PASSWORD_LENGTH) {
			setError(t("unlock.main.registerBox.passwordTooShortError", { min: MIN_PASSWORD_LENGTH }));
			return;
		}
		if (regPassword !== regPasswordConfirm) {
			setError(t("unlock.main.registerBox.passwordMismatchError"));
			return;
		}
		setError("");
		const generated = generateMnemonic();
		const key = await mnemonicToPrivateKey(generated);
		const id = bytesToHex(getPublicKey(key));
		// Этап 44 (ревью Opus) — раньше generated отбрасывалась после однократного
		// использования, фраза восстановления нигде не сохранялась. Сохраняем
		// зашифрованной ТЕМ ЖЕ паролем — "Показать фразу" в настройках (обещание,
		// которое уже давал шаг "done" ниже) теперь честно работает.
		await encryptAndStore(key, regPassword, id, { login: regLogin.trim() }, generated);
		setPrivKey(key);
		setPendingLogin(regLogin.trim());
		setNpub(npubEncode(id));
		setIsQuickRegister(true);
		setStep("done");
	}

	function openAdvanced(kind) {
		setError("");
		setAdvLogin("");
		setPassword("");
		setPasswordConfirm("");
		// Этап 44 — сброс на пустую строку для ВСЕХ веток (иначе повторный заход в
		// "создать" после "импорт по ключу" в той же сессии мог бы утащить
		// устаревшую мнемонику от предыдущей попытки в encryptAndStore).
		setMnemonic("");
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
			setError(t("unlock.main.registerBox.loginRequiredError"));
			return;
		}
		if (password.length < MIN_PASSWORD_LENGTH) {
			setError(t("unlock.main.registerBox.passwordTooShortError", { min: MIN_PASSWORD_LENGTH }));
			return;
		}
		if (password !== passwordConfirm) {
			setError(t("unlock.main.registerBox.passwordMismatchError"));
			return;
		}
		setError("");
		const id = bytesToHex(getPublicKey(privKey));
		await encryptAndStore(privKey, password, id, { login: advLogin.trim() }, mnemonic || undefined);
		setPendingLogin(advLogin.trim());
		setNpub(npubEncode(id));
		setIsQuickRegister(false);
		setStep("done");
	}

	// ── Простые/переходные состояния — сфокусированный центрированный экран,
	// без сайдбар-сетки (нечего показывать рядом, отвлекало бы). ──────────────
	if (step === "loading") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("app.name")}</h1>
				</header>
				<p style={{ color: "var(--muted)" }}>{t("unlock.checking")}</p>
			</main>
		);
	}

	if (step === "db-error") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("app.name")}</h1>
				</header>
				<div class="flow">
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{t("unlock.dbError.message")}
					</p>
					<p style={{ color: "var(--muted)" }}>
						{t("unlock.dbError.warning")}
					</p>
					<button type="button" onClick={handleResetDatabase}>
						{t("unlock.dbError.resetButton")}
					</button>
				</div>
			</main>
		);
	}

	if (step === "create-generate") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.createGenerate.title")}</h1>
				</header>
				<div class="flow">
					<p>{t("unlock.createGenerate.instructions")}</p>
					<MnemonicDisplay words={mnemonic.split(" ")} />
					<button
						type="button"
						onClick={() => {
							setConfirmInput("");
							setStep("create-confirm");
						}}
					>
						{t("unlock.createGenerate.savedButton")}
					</button>
				</div>
			</main>
		);
	}

	if (step === "create-confirm") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.createConfirm.title")}</h1>
				</header>
				<div class="flow">
					<p>{t("unlock.createConfirm.instructions")}</p>
					<label for="confirm-mnemonic">{t("unlock.createConfirm.label")}</label>
					<textarea id="confirm-mnemonic" value={confirmInput} onInput={(e) => setConfirmInput(e.currentTarget.value)} />
					<div class="cluster">
						<button
							type="button"
							onClick={async () => {
								const normalize = (s) => s.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
								if (normalize(confirmInput) !== normalize(mnemonic)) {
									setError(t("unlock.createConfirm.mismatchError"));
									return;
								}
								setError("");
								const key = await mnemonicToPrivateKey(mnemonic);
								setPrivKey(key);
								setStep("advanced-password");
							}}
						>
							{t("common.confirm")}
						</button>
						<button type="button" onClick={() => setStep("create-generate")}>
							{t("common.back")}
						</button>
					</div>
					{error && (
						<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
							{error}
						</p>
					)}
				</div>
			</main>
		);
	}

	if (step === "import-mnemonic") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.importMnemonic.title")}</h1>
				</header>
				<div class="flow">
					<p>{t("unlock.importMnemonic.instructions")}</p>
					<label for="import-mnemonic">{t("unlock.importMnemonic.label")}</label>
					<textarea id="import-mnemonic" value={importInput} onInput={(e) => setImportInput(e.currentTarget.value)} />
					<div class="cluster">
						<button
							type="button"
							onClick={async () => {
								const trimmed = importInput.trim();
								if (!validateMnemonic(trimmed)) {
									setError(t("unlock.importMnemonic.invalidError"));
									return;
								}
								setError("");
								const key = await mnemonicToPrivateKey(trimmed);
								setPrivKey(key);
								setMnemonic(trimmed);
								setStep("advanced-password");
							}}
						>
							{t("common.continue")}
						</button>
						<button type="button" onClick={() => setStep("main")}>
							{t("common.back")}
						</button>
					</div>
					{error && (
						<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
							{error}
						</p>
					)}
				</div>
			</main>
		);
	}

	if (step === "import-key") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.importKey.title")}</h1>
				</header>
				<div class="flow">
					<p>{t("unlock.importKey.instructions")}</p>
					<p style={{ color: "var(--muted)" }}>
						{t("unlock.importKey.explanation")}
					</p>
					<p style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
						<code>nsec1zh0anykm9v3grv0wmw56pauv3yks03pz8jdgj4agcyg85xqumq3qn8lrhz</code>
						<br />
						<small style={{ color: "var(--muted)" }}>{t("unlock.importKey.exampleNote")}</small>
					</p>
					<label for="import-key">{t("unlock.importKey.label")}</label>
					<input id="import-key" type="password" value={importInput} onInput={(e) => setImportInput(e.currentTarget.value)} />
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
											setError(t("unlock.importKey.wrongTypeError", { type: decoded.type }));
											return;
										}
										setPrivKey(decoded.data);
									}
									setError("");
									setStep("advanced-password");
								} catch (e) {
									setError(t("unlock.importKey.parseError", { message: e?.message || e }));
								}
							}}
						>
							{t("common.continue")}
						</button>
						<button type="button" onClick={() => setStep("main")}>
							{t("common.back")}
						</button>
					</div>
					{error && (
						<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
							{error}
						</p>
					)}
				</div>
			</main>
		);
	}

	if (step === "advanced-password") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.advancedPassword.title")}</h1>
				</header>
				<form class="flow" onSubmit={handleAdvancedPasswordSubmit}>
					<fieldset class="flow">
						<legend>{t("unlock.advancedPassword.title")}</legend>
						<label for="adv-login">{t("unlock.advancedPassword.loginLabel")}</label>
						<input id="adv-login" type="text" autocomplete="username" value={advLogin} onInput={(e) => setAdvLogin(e.currentTarget.value)} />
						<label for="adv-password">{t("unlock.advancedPassword.passwordLabel", { min: MIN_PASSWORD_LENGTH })}</label>
						<input id="adv-password" type="password" autocomplete="new-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
						<label for="adv-password-confirm">{t("unlock.advancedPassword.passwordConfirmLabel")}</label>
						<input
							id="adv-password-confirm"
							type="password"
							autocomplete="new-password"
							value={passwordConfirm}
							onInput={(e) => setPasswordConfirm(e.currentTarget.value)}
						/>
					</fieldset>
					<button type="submit">{t("common.save")}</button>
					{error && (
						<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
							{error}
						</p>
					)}
				</form>
			</main>
		);
	}

	if (step === "done") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.done.title")}</h1>
				</header>
				<div class="flow">
					<p>{t("unlock.done.message")}</p>
					<p style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{npub}</p>
					{isQuickRegister && (
						<p
							role="alert"
							style={{ padding: "var(--space-m)", background: "var(--surface)", borderInlineStart: "3px solid var(--accent)" }}
						>
							{t("unlock.done.quickRegisterWarning")}
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
						{t("unlock.done.continueButton")}
					</button>
				</div>
			</main>
		);
	}

	// ── step === "main" — собственно стартовый экран ─────────────────────────
	const openAccount = accounts.find((a) => a.id === openLoginForId);

	return (
		<div class="auth-layout">
			<header class="site-header">
				<div class="logo">
					<span class="logo-name">{t("app.name")}</span>
				</div>
				<nav class="main-nav" aria-label={t("unlock.main.navAriaLabel")}>
					{/* Кнопки, не ссылки — переключают содержимое <main> этой же страницы,
					    не настоящая навигация (тот же принцип, что везде в проекте:
					    реальное действие — реальный <button>, не div/a с подложной ролью). */}
					<ul class="nav-links">
						<li>
							<button type="button" class={mainView === "home" ? "nav-link-btn nav-link-btn--active" : "nav-link-btn"} onClick={() => setMainView("home")}>
								{t("unlock.main.navHome")}
							</button>
						</li>
						<li>
							<button
								type="button"
								class={mainView === "temp-chat" ? "nav-link-btn nav-link-btn--active" : "nav-link-btn"}
								onClick={() => setMainView("temp-chat")}
							>
								{t("unlock.main.navTempChat")}
							</button>
						</li>
						<li>
							<button type="button" class={mainView === "help" ? "nav-link-btn nav-link-btn--active" : "nav-link-btn"} onClick={() => setMainView("help")}>
								{t("nav.help")}
							</button>
						</li>
					</ul>
				</nav>
				{error && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))", margin: 0 }}>
						{error}
					</p>
				)}
				<div class="header-actions">
					<button type="button" class="btn" onClick={openRegisterBox}>
						{t("unlock.main.createSpaceButton")}
					</button>
				</div>
			</header>

			<aside class="sidebar" aria-label={t("unlock.main.sidebarAriaLabel")}>
				<section class="widget accounts-widget" aria-label={t("unlock.main.accountsWidget.ariaLabel")}>
					<h3>{t("unlock.main.accountsWidget.title")}</h3>
					{accounts.length === 0 ? (
						<p class="widget-subtitle">{t("unlock.main.accountsWidget.empty")}</p>
					) : (
						<ul class="accounts-list">
							{accounts.map((acc) => (
								<li key={acc.id}>
									<button
										type="button"
										class="account-picker-btn"
										aria-current={openLoginForId === acc.id ? "true" : undefined}
										onClick={() => openLoginFor(acc.id)}
									>
										<AccountAvatar avatar={acc.avatar} login={acc.login || acc.id} />
										<span class="account-name">{acc.login || acc.id.slice(0, 16) + "…"}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</section>

				{openAccount && (
					<section class="widget auth-box" aria-live="polite">
						<div class="auth-box-header">
							<AccountAvatar avatar={openAccount.avatar} login={openAccount.login || openAccount.id} large />
							<h4>{openAccount.login || openAccount.id.slice(0, 16) + "…"}</h4>
						</div>
						<form class="auth-form" onSubmit={handleLoginSubmit}>
							<div class="form-group">
								<label for="login-password">{t("unlock.main.loginForm.passwordLabel")}</label>
								<input
									id="login-password"
									type="password"
									autocomplete="current-password"
									value={loginPassword}
									onInput={(e) => setLoginPassword(e.currentTarget.value)}
								/>
							</div>
							<button type="submit" class="btn btn-block">
								{t("unlock.main.loginForm.submitButton", { appName: t("app.name") })}
							</button>
							{accounts.length > 1 && (
								<button type="button" class="btn-link" onClick={() => setOpenLoginForId(null)}>
									{t("unlock.main.loginForm.switchAccountButton")}
								</button>
							)}
						</form>
					</section>
				)}

				{registerBoxOpen && (
					<section class="widget auth-box" aria-live="polite">
						<h4>{t("unlock.main.registerBox.title")}</h4>
						<p class="widget-subtitle">{t("unlock.main.registerBox.subtitle")}</p>
						<form class="auth-form" onSubmit={handleRegisterSubmit}>
							<div class="form-group">
								<label for="reg-login">{t("unlock.main.registerBox.loginLabel")}</label>
								<input
									id="reg-login"
									type="text"
									autocomplete="username"
									value={regLogin}
									onInput={(e) => setRegLogin(e.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="reg-password">{t("unlock.main.registerBox.passwordLabel")}</label>
								<input
									id="reg-password"
									type="password"
									autocomplete="new-password"
									value={regPassword}
									onInput={(e) => setRegPassword(e.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="reg-password-confirm">{t("unlock.advancedPassword.passwordConfirmLabel")}</label>
								<input
									id="reg-password-confirm"
									type="password"
									autocomplete="new-password"
									value={regPasswordConfirm}
									onInput={(e) => setRegPasswordConfirm(e.currentTarget.value)}
								/>
							</div>
							<button type="submit" class="btn btn-block">
								{t("unlock.main.registerBox.submitButton")}
							</button>
							{accounts.length > 0 && (
								<button type="button" class="btn-link" onClick={() => setRegisterBoxOpen(false)}>
									{t("common.cancel")}
								</button>
							)}
						</form>
					</section>
				)}

				<section class="widget">
					<h3>{t("unlock.main.otherWays.title")}</h3>
					<p class="widget-subtitle">{t("unlock.main.otherWays.subtitle")}</p>
					<ul class="link-list">
						<li>
							<button type="button" class="link-list-item" onClick={() => openAdvanced("create")}>
								{t("unlock.main.otherWays.createWithPhrase")}
							</button>
						</li>
						<li>
							<button type="button" class="link-list-item" onClick={() => openAdvanced("import-mnemonic")}>
								{t("unlock.main.otherWays.importMnemonic")}
							</button>
						</li>
						<li>
							<button type="button" class="link-list-item" onClick={() => openAdvanced("import-key")}>
								{t("unlock.main.otherWays.importKey")}
							</button>
						</li>
					</ul>
				</section>
			</aside>

			<main>
				{mainView === "home" && (
					<section class="hero-section">
						<h1>{t("unlock.main.hero.title")}</h1>
						<p class="hero-lead">
							{t("unlock.main.hero.lead", { appName: t("app.name") })}
						</p>
					</section>
				)}
				{mainView === "temp-chat" && (
					<section class="hero-section flow">
						<h1>{t("unlock.main.tempChat.title")}</h1>
						<p class="hero-lead">
							{t("unlock.main.tempChat.lead1")}
						</p>
						<p class="hero-lead">{t("unlock.main.tempChat.lead2")}</p>
					</section>
				)}
				{mainView === "help" && <HelpContent />}
			</main>

			<footer class="site-footer">
				<p>{t("unlock.main.footer.tagline", { appName: t("app.name") })}</p>
				<p>
					{t("unlock.main.footer.alphaNotice")}
				</p>
			</footer>
		</div>
	);
}
