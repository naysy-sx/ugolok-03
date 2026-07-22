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

const MIN_PASSWORD_LENGTH = 8;

// Стартовый экран — первое, что видит и гость, и вернувшийся пользователь (единый
// экран по решению пользователя: раньше это были два разных роута/компонента,
// Unlock и Onboarding, теперь слиты в один — вход, регистрация и "другие способы"
// живут виджетами одной страницы, без перехода между роутами).
export default function Unlock() {
	const [step, setStep] = useState("loading");
	const [accounts, setAccounts] = useState([]);

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
			setError("Выберите аккаунт.");
			return;
		}
		try {
			const key = await decryptPrivateKey(loginPassword, openLoginForId);
			const account = accounts.find((a) => a.id === openLoginForId);
			login(openLoginForId, account?.login ?? "", key);
			setRememberedAccountId(openLoginForId);
			navigate("/main");
		} catch {
			setError("Неверный пароль.");
		}
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

	// ── Простые/переходные состояния — сфокусированный центрированный экран,
	// без сайдбар-сетки (нечего показывать рядом, отвлекало бы). ──────────────
	if (step === "loading") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">Уголок</p>
					<h1>Уголок</h1>
				</header>
				<p style={{ color: "var(--muted)" }}>Проверка…</p>
			</main>
		);
	}

	if (step === "db-error") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">Уголок</p>
					<h1>Уголок</h1>
				</header>
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
			</main>
		);
	}

	if (step === "create-generate") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">Уголок</p>
					<h1>Фраза восстановления</h1>
				</header>
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
			</main>
		);
	}

	if (step === "create-confirm") {
		return (
			<main class="center flow" style={{ "--container": "44rem" }}>
				<header class="flow">
					<p class="eyebrow">Уголок</p>
					<h1>Подтверждение фразы</h1>
				</header>
				<div class="flow">
					<p>Введите фразу ещё раз, чтобы подтвердить, что вы её сохранили.</p>
					<label for="confirm-mnemonic">Мнемоническая фраза (12 слов через пробел)</label>
					<textarea id="confirm-mnemonic" value={confirmInput} onInput={(e) => setConfirmInput(e.currentTarget.value)} />
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
					<p class="eyebrow">Уголок</p>
					<h1>Вход по мнемонике</h1>
				</header>
				<div class="flow">
					<p>Введите вашу мнемоническую фразу (12 слов через пробел).</p>
					<label for="import-mnemonic">Мнемоническая фраза</label>
					<textarea id="import-mnemonic" value={importInput} onInput={(e) => setImportInput(e.currentTarget.value)} />
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
					<p class="eyebrow">Уголок</p>
					<h1>Вход по ключу</h1>
				</header>
				<div class="flow">
					<p>Введите приватный ключ в формате nsec1... или как hex-строку (64 символа).</p>
					<p style={{ color: "var(--muted)" }}>
						Приватный ключ — секретная строка, которая даёт полный доступ к вашему аккаунту. Никогда и никому её не
						показывайте. В формате <code>nsec</code> (NIP-19, bech32) она начинается с <code>nsec1</code> и выглядит
						примерно так:
					</p>
					<p style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
						<code>nsec1zh0anykm9v3grv0wmw56pauv3yks03pz8jdgj4agcyg85xqumq3qn8lrhz</code>
						<br />
						<small style={{ color: "var(--muted)" }}>(это лишь пример формата, не настоящий ключ)</small>
					</p>
					<label for="import-key">Приватный ключ</label>
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
					<p class="eyebrow">Уголок</p>
					<h1>Данные аккаунта</h1>
				</header>
				<form class="flow" onSubmit={handleAdvancedPasswordSubmit}>
					<fieldset class="flow">
						<legend>Данные аккаунта</legend>
						<label for="adv-login">Логин</label>
						<input id="adv-login" type="text" autocomplete="username" value={advLogin} onInput={(e) => setAdvLogin(e.currentTarget.value)} />
						<label for="adv-password">Пароль (минимум {MIN_PASSWORD_LENGTH} символов)</label>
						<input id="adv-password" type="password" autocomplete="new-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
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
					<p class="eyebrow">Уголок</p>
					<h1>Готово</h1>
				</header>
				<div class="flow">
					<p>Готово! Ваш публичный идентификатор:</p>
					<p style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{npub}</p>
					{isQuickRegister && (
						<p
							role="alert"
							style={{ padding: "var(--space-m)", background: "var(--surface)", borderInlineStart: "3px solid var(--accent)" }}
						>
							Быстрая регистрация: секретная фраза восстановления не показывалась и нигде не сохранялась вами. Если это
							устройство или браузерное хранилище будет потеряно — восстановить доступ к аккаунту будет нечем. Показать
							фразу для резервной копии можно будет позже в настройках.
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
			</main>
		);
	}

	// ── step === "main" — собственно стартовый экран ─────────────────────────
	const openAccount = accounts.find((a) => a.id === openLoginForId);

	return (
		<div class="auth-layout">
			<header class="site-header">
				<div class="logo">
					<span class="logo-name">Уголок</span>
				</div>
				<nav class="main-nav" aria-label="Главное меню">
					{/* Пока пустые — приложение под Android будет скачиваться именно
					    с этой страницы, ссылки займут места заранее. */}
					<ul class="nav-links">
						<li><a href="#">Главная</a></li>
						<li><a href="#">Возможности</a></li>
						<li><a href="#">Скачать APK</a></li>
					</ul>
				</nav>
				{error && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))", margin: 0 }}>
						{error}
					</p>
				)}
				<div class="header-actions">
					<button type="button" class="btn" onClick={openRegisterBox}>
						Создать пространство
					</button>
				</div>
			</header>

			<aside class="sidebar" aria-label="Управление аккаунтами и доступ">
				<section class="widget accounts-widget" aria-label="Выбор профиля">
					<h3>Аккаунты на устройстве</h3>
					{accounts.length === 0 ? (
						<p class="widget-subtitle">Пока нет ни одного локального аккаунта — создайте первый справа.</p>
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
								<label for="login-password">Пароль от этого пространства</label>
								<input
									id="login-password"
									type="password"
									autocomplete="current-password"
									value={loginPassword}
									onInput={(e) => setLoginPassword(e.currentTarget.value)}
								/>
							</div>
							<button type="submit" class="btn btn-block">
								Войти в Уголок
							</button>
							{accounts.length > 1 && (
								<button type="button" class="btn-link" onClick={() => setOpenLoginForId(null)}>
									Выбрать другой аккаунт
								</button>
							)}
						</form>
					</section>
				)}

				{registerBoxOpen && (
					<section class="widget auth-box" aria-live="polite">
						<h4>Создать новое пространство</h4>
						<p class="widget-subtitle">Аккаунт будет создан локально на этом устройстве.</p>
						<form class="auth-form" onSubmit={handleRegisterSubmit}>
							<div class="form-group">
								<label for="reg-login">Придумайте уникальный никнейм</label>
								<input
									id="reg-login"
									type="text"
									autocomplete="username"
									value={regLogin}
									onInput={(e) => setRegLogin(e.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="reg-password">Мастер-пароль (для шифрования данных)</label>
								<input
									id="reg-password"
									type="password"
									autocomplete="new-password"
									value={regPassword}
									onInput={(e) => setRegPassword(e.currentTarget.value)}
								/>
							</div>
							<div class="form-group">
								<label for="reg-password-confirm">Повторите пароль</label>
								<input
									id="reg-password-confirm"
									type="password"
									autocomplete="new-password"
									value={regPasswordConfirm}
									onInput={(e) => setRegPasswordConfirm(e.currentTarget.value)}
								/>
							</div>
							<button type="submit" class="btn btn-block">
								Зарегистрироваться
							</button>
							{accounts.length > 0 && (
								<button type="button" class="btn-link" onClick={() => setRegisterBoxOpen(false)}>
									Отмена
								</button>
							)}
						</form>
					</section>
				)}

				<section class="widget">
					<h3>Другие способы</h3>
					<p class="widget-subtitle">Для опытных пользователей.</p>
					<ul class="link-list">
						<li>
							<button type="button" class="link-list-item" onClick={() => openAdvanced("create")}>
								Создать с показом фразы восстановления
							</button>
						</li>
						<li>
							<button type="button" class="link-list-item" onClick={() => openAdvanced("import-mnemonic")}>
								Войти по мнемонике
							</button>
						</li>
						<li>
							<button type="button" class="link-list-item" onClick={() => openAdvanced("import-key")}>
								Войти по ключу (nsec)
							</button>
						</li>
					</ul>
				</section>
			</aside>

			<main>
				<section class="hero-section">
					<h1>Приватное пространство для общения без центрального сервера</h1>
					<p class="hero-lead">
						Уголок — мессенджер на протоколе Nostr с сквозным шифрованием (MLS) для переписки и шифрованием базы
						данных на устройстве. Работает в локальной сети, без публичного интернета.
					</p>
				</section>
			</main>

			<footer class="site-footer">
				<p>Уголок — приватный мессенджер.</p>
				<p>
					Альфа-тестирование. Данные шифруются ключом, производным от вашего мастер-пароля, и хранятся локально на
					этом устройстве.
				</p>
			</footer>
		</div>
	);
}
