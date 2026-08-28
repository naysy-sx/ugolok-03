import { useState, useEffect } from "preact/hooks";
import { currentUser, lock } from "../signals/auth.js";
import { listAccounts } from "../../core/crypto/keystore.js";
import Screen from "../components/screen.jsx";
import MnemonicReveal from "../components/mnemonic-reveal.jsx";
import IconShield from "../icons/shield.jsx";
import { t } from "../signals/i18n.js";

// Пункты меню учётной записи "Секретная фраза" и "Восстановить доступ"
// вели ОБА в "Настройки", в верх страницы из девяти разделов: меню
// обещало два места и приводило в одно, причём не туда. Здесь оба
// обещания выполняются, и меню сводится к одному пункту (account-card.jsx).
//
// ВАЖНО про восстановление: внутриприложенного потока восстановления по
// фразе не существует — единственный такой поток (import-mnemonic,
// unlock.jsx) доступен ДО входа. Поэтому здесь не форма, а объяснение и
// кнопка, ведущая туда, где поток есть: lock() выгружает ключи и
// возвращает на экран входа. Не заменять это собственной формой — она
// была бы дублирующей реализацией криптографического пути.
export default function Security() {
	const ownerPubkey = currentUser.value.id;
	const login = currentUser.value.login;
	const [hasMnemonic, setHasMnemonic] = useState(false);

	useEffect(() => {
		listAccounts().then((accounts) => {
			setHasMnemonic(!!accounts.find((a) => a.id === ownerPubkey)?.hasMnemonic);
		});
	}, [ownerPubkey]);

	return (
		// Живой фидбег: заголовок "Ключ и восстановление" сбивал с толку —
		// ключ (публичный идентификатор) на этом экране не показан вовсе,
		// он на "Профиль и аватар". {{имя}}: секретная фраза — про то, что
		// РЕАЛЬНО здесь есть. Дублирующий h2 "Секретная фраза" первой
		// секции убран (это уже заголовок экрана); у второй секции
		// ("Восстановление доступа") — другая тема, её h2 остаётся.
		<Screen title={`${login || t("profile.noNameFallback")}: ${t("security.mnemonicTitle")}`}>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
				<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
						<p class="panel__hint">{t("security.mnemonicHint")}</p>
					</div>
					<div class="callout callout--warn row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<span class="grow">{t("security.mnemonicWarning")}</span>
					</div>
					<MnemonicReveal ownerPubkey={ownerPubkey} hasMnemonic={hasMnemonic} />
				</section>

				<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
						<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
							<IconShield />
							{t("security.recoverTitle")}
						</h2>
					</div>
					<p class="panel__hint">{t("security.recoverBody")}</p>
					<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<button type="button" class="btn--ghost rigid" onClick={() => lock()}>
							{t("security.recoverButton")}
						</button>
					</div>
				</section>
			</div>
		</Screen>
	);
}
