import { useState, useEffect, useRef } from "preact/hooks";
import { generateMnemonic, validateMnemonic, mnemonicToPrivateKey } from "../../core/crypto/mnemonic.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encryptAndStore, decryptPrivateKey, listAccounts, getProfile, recordLastUnlock, lastUnlockBucket } from "../../core/crypto/keystore.js";
import { t, tPlural, errorMessage, currentLocale } from "../signals/i18n.js";
import { resetLocalDatabase } from "../../core/store/database.js";
import { navigate } from "../router.js";
import { login, setRememberedAccountId, getRememberedAccountId, dbKeySig } from "../signals/auth.js";
import { loadUiSettings } from "../../domain/settings/ui-settings.js";
import { applyCustomPalette } from "../theme/palette-apply.js";
import { applyUiScale } from "../theme/ui-scale.js";
import { applyThemeMode } from "../theme/theme-mode.js";
import { decode as nip19Decode, npubEncode } from "nostr-tools/nip19";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import MnemonicDisplay from "../components/mnemonic-display.jsx";
import AccountAvatar from "../components/account-avatar.jsx";
import HelpContent from "../components/help-content.jsx";
import ConnectionEndpoints from "../components/connection-endpoints.jsx";
import IconMicrophone from "../icons/microphone.jsx";
import Quick from "./quick.jsx";


const MIN_PASSWORD_LENGTH = 8;

function lastUnlockLabel(ts) {
	const bucket = lastUnlockBucket(ts);
	if (!bucket) return null;
	if (bucket.kind === "today") return t("unlock.main.accountMeta.today");
	if (bucket.kind === "yesterday") return t("unlock.main.accountMeta.yesterday");
	if (bucket.kind === "days") return tPlural("unlock.main.accountMeta.daysAgo", bucket.count);
	return t("unlock.main.accountMeta.date", {
		date: new Intl.DateTimeFormat(currentLocale.value, { day: "numeric", month: "short" }).format(new Date(bucket.ts)),
	});
}

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

	// Вкладки Войти | Создать на step === "main" (взаимоисключающие).
	const [authMode, setAuthMode] = useState("create");
	const [openLoginForId, setOpenLoginForId] = useState(null);
	const [loginPassword, setLoginPassword] = useState("");
	const passwordInputRef = useRef(null);

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
	const [mainCreatePending, setMainCreatePending] = useState(false);
	const [pendingLogin, setPendingLogin] = useState("");
	const [error, setError] = useState("");
	// Био под именем в раскрытой карточке входа (пользователь) — listAccounts()
	// его не даёт (только id/login/avatar/hasMnemonic), отдельный запрос
	// getProfile per id. Тот же уровень доступа, что уже есть у avatar в
	// этом же списке — bio лежит в keystore нешифрованным, читать до входа
	// не новый прецедент.
	const [openAccountBio, setOpenAccountBio] = useState("");

	useEffect(() => {
		(async () => {
			try {
				const list = await listAccounts();
				setAccounts(list);
				if (list.length === 0) {
					setAuthMode("create");
				} else {
					setAuthMode("login");
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

	// Био для раскрытой карточки входа — отдельно от listAccounts() (тот его
	// не отдаёт), запрашивается заново при смене openLoginForId. Хук должен
	// стоять здесь, а не рядом с использованием (JSX ниже, "step === main") —
	// там уже прошли несколько ранних return для других step, порядок хуков
	// нарушился бы.
	useEffect(() => {
		if (!openLoginForId) {
			setOpenAccountBio("");
			return;
		}
		let cancelled = false;
		getProfile(openLoginForId)
			.then((profile) => {
				if (!cancelled) setOpenAccountBio(profile.bio);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [openLoginForId]);

	useEffect(() => {
		if (step !== "main" || authMode !== "login" || !openLoginForId) return;
		passwordInputRef.current?.focus();
	}, [openLoginForId, authMode, step]);

	async function handleResetDatabase() {
		await resetLocalDatabase();
		location.reload();
	}

	function openLoginFor(id) {
		setError("");
		setLoginPassword("");
		setAuthMode("login");
		setOpenLoginForId(id);
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
			recordLastUnlock(openLoginForId).catch(() => {});
			// Найдено пользователем (баг) — тема/масштаб/акцент применялись только
			// внутри MainShell'а ПОСЛЕ навигации (app.jsx), поэтому на секунду
			// показывался build-дефолт вместо сохранённой темы ЭТОГО аккаунта.
			// dbKeySig уже установлен синхронно внутри login() (deriveDbKey), поэтому
			// можно прочитать/применить настройки СРАЗУ здесь, до navigate — MainShell
			// применит их же повторно на mount, это идемпотентно, не проблема.
			// Best-effort, в СВОЁМ try — пароль уже проверен выше (decryptPrivateKey
			// не бросил), сбой здесь не должен ложно показать "неверный пароль".
			try {
				const loaded = await loadUiSettings(openLoginForId, dbKeySig.value);
				applyCustomPalette(loaded.customPalette);
				applyUiScale(loaded.uiScale);
				applyThemeMode(loaded.themeMode);
			} catch {
				// не критично — MainShell попробует применить настройки ещё раз на mount
			}
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
		setMnemonic(generated);
		setPendingLogin(regLogin.trim());
		setMainCreatePending(true);
		setIsQuickRegister(false);
		setStep("create-generate");
	}

	function openAdvanced(kind) {
		setError("");
		setMainCreatePending(false);
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
			<main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
				<header class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("app.name")}</h1>
				</header>
				<p style={{ color: "var(--muted)" }}>{t("unlock.checking")}</p>
			</main>
		);
	}

	if (step === "db-error") {
		return (
			<main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
				<header class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("app.name")}</h1>
				</header>
				<div class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p role="alert" style={{ color: "var(--bad)" }}>
						{t("unlock.dbError.message")}
					</p>
					<p style={{ color: "var(--muted)" }}>
						{t("unlock.dbError.warning")}
					</p>
					<button type="button" class="btn--ghost btn--danger" onClick={handleResetDatabase}>
						{t("unlock.dbError.resetButton")}
					</button>
				</div>
			</main>
		);
	}

	if (step === "create-generate") {
		return (
			<main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
				<header class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.createGenerate.title")}</h1>
				</header>
				<div class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p>{t("unlock.createGenerate.instructions")}</p>
					<MnemonicDisplay words={mnemonic.split(" ")} />
					<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<button
							type="button"
							onClick={() => {
								setConfirmInput("");
								setStep("create-confirm");
							}}
						>
							{t("unlock.createGenerate.savedButton")}
						</button>
						<button type="button" onClick={() => setStep("main")}>
							{t("common.back")}
						</button>
					</div>
				</div>
			</main>
		);
	}

	if (step === "create-confirm") {
		return (
			<main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
				<header class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.createConfirm.title")}</h1>
				</header>
				<div class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p>{t("unlock.createConfirm.instructions")}</p>
					<label for="confirm-mnemonic">{t("unlock.createConfirm.label")}</label>
					<textarea id="confirm-mnemonic" value={confirmInput} onInput={(e) => setConfirmInput(e.currentTarget.value)} />
					<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
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
								if (mainCreatePending) {
									const id = bytesToHex(getPublicKey(key));
									await encryptAndStore(key, regPassword, id, { login: pendingLogin }, mnemonic);
									setNpub(npubEncode(id));
									setIsQuickRegister(false);
									setMainCreatePending(false);
									setStep("done");
								} else {
									setStep("advanced-password");
								}
							}}
						>
							{t("common.confirm")}
						</button>
						<button type="button" onClick={() => setStep("create-generate")}>
							{t("common.back")}
						</button>
					</div>
					{error && (
						<p role="alert" style={{ color: "var(--bad)" }}>
							{error}
						</p>
					)}
				</div>
			</main>
		);
	}

	if (step === "import-mnemonic") {
		return (
			<main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
				<header class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.importMnemonic.title")}</h1>
				</header>
				<div class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p>{t("unlock.importMnemonic.instructions")}</p>
					<label for="import-mnemonic">{t("unlock.importMnemonic.label")}</label>
					<textarea id="import-mnemonic" value={importInput} onInput={(e) => setImportInput(e.currentTarget.value)} />
					<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
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
						<p role="alert" style={{ color: "var(--bad)" }}>
							{error}
						</p>
					)}
				</div>
			</main>
		);
	}

	if (step === "import-key") {
		return (
			<main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
				<header class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.importKey.title")}</h1>
				</header>
				<div class="stack" style={{ "--gap": "var(--space-m)" }}>
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
					<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
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
									setError(t("unlock.importKey.parseError", { message: errorMessage(e) }));
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
						<p role="alert" style={{ color: "var(--bad)" }}>
							{error}
						</p>
					)}
				</div>
			</main>
		);
	}

	if (step === "advanced-password") {
		return (
			<main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
				<header class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.advancedPassword.title")}</h1>
				</header>
				<form class="stack" style={{ "--gap": "var(--space-m)" }} onSubmit={handleAdvancedPasswordSubmit}>
					<fieldset class="stack" style={{ "--gap": "var(--space-m)" }}>
						<legend>{t("unlock.advancedPassword.title")}</legend>
						<p style={{ color: "var(--muted)" }}>{t("unlock.immutableNotice")}</p>
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
						<p role="alert" style={{ color: "var(--bad)" }}>
							{error}
						</p>
					)}
				</form>
			</main>
		);
	}

	if (step === "done") {
		return (
			<main class="center stack" style={{ "--measure": "44rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)" }}>
				<header class="stack" style={{ "--gap": "var(--space-m)" }}>
					<p class="eyebrow">{t("app.name")}</p>
					<h1>{t("unlock.done.title")}</h1>
				</header>
				<div class="stack" style={{ "--gap": "var(--space-m)" }}>
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
							recordLastUnlock(id).catch(() => {});
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
	const rememberedId = getRememberedAccountId();

	return (
		<div class="screen auth-layout">
			<header class="site-header bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<div class="logo row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					<span class="unlock-logo-mark" aria-hidden="true" />
					<span class="logo-name">{t("app.name")}</span>
				</div>
				<div class="header-actions">
					<button
						type="button"
						class={mainView === "help" ? "btn-link nav-link-btn--active" : "btn-link"}
						onClick={() => setMainView(mainView === "help" ? "home" : "help")}
					>
						{t("unlock.main.helpLink")}
					</button>
				</div>
			</header>

			<main class="main">
				{mainView === "home" && (
					<div class="unlock-home">
						<section class="hero-section">
							<h1>{t("unlock.main.hero.title")}</h1>
							<p class="hero-lead">{t("unlock.main.hero.lead")}</p>
						</section>

						<section class="card unlock-card stack" style={{ "--gap": "var(--space-m)" }}>
							<div class="unlock-modes" role="tablist" aria-label={t("unlock.main.modes.login")}>
								<button
									type="button"
									role="tab"
									id="unlock-tab-login"
									aria-selected={authMode === "login"}
									aria-controls="unlock-panel-login"
									onClick={() => setAuthMode("login")}
								>
									{t("unlock.main.modes.login")}
								</button>
								<button
									type="button"
									role="tab"
									id="unlock-tab-create"
									aria-selected={authMode === "create"}
									aria-controls="unlock-panel-create"
									onClick={() => setAuthMode("create")}
								>
									{t("unlock.main.modes.create")}
								</button>
							</div>

							{authMode === "login" && (
								<div id="unlock-panel-login" role="tabpanel" aria-labelledby="unlock-tab-login" class="stack" style={{ "--gap": "var(--space-m)" }}>
									<div class="unlock-card-header stack" style={{ "--gap": "var(--space-3xs)" }}>
										<h2>{t("unlock.main.accountsWidget.title")}</h2>
										{accounts.length === 0 && <p class="unlock-muted">{t("unlock.main.accountsWidget.empty")}</p>}
									</div>
									{accounts.length > 0 && (
										<ul class="accounts-list stack" style={{ "--gap": "var(--space-2xs)" }} aria-label={t("unlock.main.accountsWidget.ariaLabel")}>
											{accounts.map((acc) => {
												const meta = lastUnlockLabel(acc.lastUnlockAt);
												return (
												<li key={acc.id}>
													<button
														type="button"
														class="account-picker-btn row"
														style={{ "--gap": "var(--space-s)", "--align": "center" }}
														aria-current={openLoginForId === acc.id ? "true" : undefined}
														aria-pressed={openLoginForId === acc.id}
														onClick={() => openLoginFor(acc.id)}
													>
														<AccountAvatar large avatar={acc.avatar} login={acc.login || acc.id} />
														<span class="account-info stack" style={{ "--gap": "2px", "--align": "start", minWidth: 0, flex: 1 }}>
															<span class="account-name">{acc.login || acc.id.slice(0, 16) + "…"}</span>
															{meta && <span class="account-meta">{meta}</span>}
														</span>
														{acc.id === rememberedId && <span class="unlock-recent-badge">{t("unlock.main.recentBadge")}</span>}
													</button>
												</li>
												);
											})}
										</ul>
									)}
									{openAccount && (
										<form class="auth-form stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleLoginSubmit}>
											<div class="form-group">
												<label for="login-password">{t("unlock.main.loginForm.passwordLabel")}</label>
												<input
													id="login-password"
													ref={passwordInputRef}
													type="password"
													autocomplete="current-password"
													value={loginPassword}
													onInput={(e) => setLoginPassword(e.currentTarget.value)}
												/>
											</div>
											<button type="submit" class="btn btn-block">
												{t("unlock.main.loginForm.submitButton", { appName: t("app.name") })}
											</button>
										</form>
									)}
								</div>
							)}

							{authMode === "create" && (
								<div id="unlock-panel-create" role="tabpanel" aria-labelledby="unlock-tab-create" class="stack" style={{ "--gap": "var(--space-m)" }}>
									<div class="unlock-card-header stack" style={{ "--gap": "var(--space-3xs)" }}>
										<h2>{t("unlock.main.registerBox.title")}</h2>
										<p class="unlock-muted">{t("unlock.main.registerBox.subtitle")}</p>
									</div>
									<form class="auth-form stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleRegisterSubmit}>
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
											{t("unlock.main.create.continue")}
										</button>
									</form>
								</div>
							)}

							{error && (
								<p role="alert" style={{ color: "var(--bad)", margin: 0 }}>
									{error}
								</p>
							)}
						</section>

						<button type="button" class="unlock-quick-card" onClick={() => setMainView("temp-chat")}>
							<span class="unlock-quick-icon" aria-hidden="true">
								<IconMicrophone />
							</span>
							<span class="unlock-quick-text">
								<strong>{t("unlock.main.quickCard.title")}</strong>
								<span>{t("unlock.main.quickCard.subtitle")}</span>
							</span>
						</button>

						<ConnectionEndpoints />

						<details class="unlock-advanced">
							<summary>{t("unlock.main.otherWays.title")}</summary>
							<div class="unlock-advanced-list stack" style={{ "--gap": "var(--space-3xs)" }}>
								<p class="unlock-muted">{t("unlock.main.otherWays.subtitle")}</p>
								<ul class="link-list stack" style={{ "--gap": "var(--space-3xs)" }}>
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
							</div>
						</details>
					</div>
				)}
				{mainView === "temp-chat" && <Quick />}
				{mainView === "help" && <HelpContent />}
			</main>

			<footer class="site-footer">
				<p>{t("unlock.main.footer.tagline", { appName: t("app.name") })}</p>
			</footer>
		</div>
	);
}
