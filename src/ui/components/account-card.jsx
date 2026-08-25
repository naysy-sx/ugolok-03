import { useState, useEffect } from "preact/hooks";
import { npubEncode } from "nostr-tools/nip19";
import { currentUser, lock } from "../signals/auth.js";
import { profileActivity } from "../signals/profile.js";
import { connState, synced } from "../signals/transport.js";
import { getProfile } from "../../core/crypto/keystore.js";
import { resolveEffectiveTheme } from "../theme/theme-mode.js";
import { pushToast } from "../signals/toasts.js";
import { relayStatusInfo } from "./connection-status.jsx";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import AccountAvatar from "./account-avatar.jsx";
import IconGear from "../icons/gear.jsx";
import IconPerson from "../icons/person.jsx";
import IconSun from "../icons/sun.jsx";
import IconMoon from "../icons/moon.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import IconFolder from "../icons/folder.jsx";
import IconHelpCircle from "../icons/help-circle.jsx";
import IconActivityLog from "../icons/activity-log.jsx";
import IconExit from "../icons/exit.jsx";
import IconCopy from "../icons/copy.jsx";
import IconChevronDown from "../icons/chevron-down.jsx";
import IconBell from "../icons/bell.jsx";
import { t } from "../signals/i18n.js";

// Первые 9 символов npub + многоточие + последние 4 (ASIDE-REDESIGN/
// SIDEBAR-SPEC-2.md, этап 2) — npub bech32, алфавит фиксированной ширины,
// обрезка по числу символов здесь допустима (не текст произвольной длины).
// В буфер обмена (handleCopyKey ниже) идёт ПОЛНЫЙ npub, эта строка — только
// для отображения.
function shortNpub(pubkeyHex) {
	const npub = npubEncode(pubkeyHex);
	return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
}

// ASIDE-REDESIGN/SIDEBAR-SPEC.md, этап 3 — карточка учётной записи БОЛЬШЕ
// НЕ <details> и не одна кликабельная цель на всю карточку (было —
// sidebar-profile-card.jsx, вся строка аватар+имя+био+шеврон как один
// <summary>-триггер): одна большая цель не даёт разместить внутри мелкие
// (копирование ключа), а на выезжающей панели телефона большой триггер
// срабатывает от случайного касания при скролле. Три отдельные мелкие
// цели: портрет (открыть "Профиль"), кнопка "скопировать ключ", кнопка
// "ещё" (меню).
export default function AccountCard({ onEditProfile, onOpenStorage, onOpenSettings, onOpenSecurity, onOpenHelp, onOpenDiagnostics, onOpenJournal, unreadJournalCount, themeMode, onToggleTheme }) {
	const id = currentUser.value.id;
	const login = currentUser.value.login;
	const [avatar, setAvatar] = useState("");
	const [avatarUrl, setAvatarUrl] = useState("");
	const [bio, setBio] = useState("");
	const { ref: menuRef, handleMenuClick } = useDetailsMenu();

	useEffect(() => {
		let cancelled = false;
		getProfile(id).then((profile) => {
			if (cancelled) return;
			setAvatar(profile.avatar);
			setAvatarUrl(profile.avatarUrl);
			setBio(profile.bio);
		});
		return () => {
			cancelled = true;
		};
	}, [id, profileActivity.value]);

	// Тишина означает норму: строка предупреждения существует в DOM только
	// когда состояние НЕ ok. Постоянная «3 реле на связи» через неделю
	// становится невидимой ровно как шум — появление текста само по себе
	// должно нести сигнал.
	const relay = relayStatusInfo(connState.value, synced.value);
	const degraded = relay.tone !== "ok";

	async function handleCopyKey() {
		try {
			await navigator.clipboard.writeText(npubEncode(id));
			pushToast({ title: t("account.keyCopied") });
		} catch {
			pushToast({ title: t("account.keyCopyFailed") });
		}
	}

	return (
		<div class="account stack" style={{ "--gap": "var(--space-3xs)" }}>
			{/* Портрет — кнопка ровно с одной ролью: открыть «Профиль».
			    Вешать сюда ещё и меню нельзя: человек, пришедший посмотреть
			    своё фото, будет каждый раз получать список с «Выйти». */}
			<button type="button" class="account-portrait" onClick={onEditProfile} aria-label={t("account.portraitAria")} data-hint={t("account.portraitHint")}>
				<AccountAvatar avatar={avatar || avatarUrl} login={login || id} />
				<span class={`account-dot${degraded ? " account-dot--warn" : ""}`} aria-hidden="true" />
			</button>

			<details class="account-menu" ref={menuRef} onClick={handleMenuClick}>
				<summary aria-label={t("account.menuAria")}>
					<span class="account-trigger">
						<strong class="account-name truncate" title={login || id}>
							{login || id.slice(0, 16) + "…"}
						</strong>
						{unreadJournalCount > 0 && <span class="unread-dot" aria-hidden="true" />}
						<span class="account-chev" aria-hidden="true">
							<IconChevronDown />
						</span>
					</span>
				</summary>
				<div class="menu-pop stack" style={{ "--gap": "0" }}>
					<ul class="stack" style={{ "--gap": "1px" }}>
						<li>
							<button type="button" onClick={onEditProfile}>
								<IconPerson /> {t("sidebarCard.menuProfile")}
							</button>
						</li>
						<li>
							<button type="button" onClick={onOpenSettings}>
								<IconGear /> {t("sidebarCard.menuSettings")}
							</button>
						</li>
						<li>
							<button type="button" onClick={onToggleTheme}>
								{resolveEffectiveTheme(themeMode) === "dark" ? <IconSun /> : <IconMoon />} {t("sidebarCard.menuTheme")}
								<span class="menu-hint">{resolveEffectiveTheme(themeMode) === "dark" ? t("themeStatus.dark") : t("themeStatus.light")}</span>
							</button>
						</li>
					</ul>
					<ul class="stack" style={{ "--gap": "1px" }}>
						<li>
							<button type="button" onClick={onOpenJournal}>
								<IconBell /> {t("account.menuJournal")}
								{unreadJournalCount > 0 && <span class="menu-hint">{unreadJournalCount}</span>}
							</button>
						</li>
						<li>
							<button type="button" onClick={onOpenSecurity}>
								<IconLockClosed /> {t("sidebarCard.menuMnemonic")}
							</button>
						</li>
						<li>
							<button type="button" onClick={onOpenStorage}>
								<IconFolder /> {t("sidebarCard.storageMenuItem")}
							</button>
						</li>
						<li>
							<button type="button" onClick={onOpenDiagnostics}>
								<IconActivityLog /> {t("sidebarCard.menuDiagnostics")}
							</button>
						</li>
						<li>
							<button type="button" onClick={onOpenHelp}>
								<IconHelpCircle /> {t("sidebarCard.menuHelp")}
							</button>
						</li>
					</ul>
					<ul class="stack" style={{ "--gap": "1px" }}>
						<li>
							<button type="button" onClick={lock}>
								<IconExit /> {t("shell.logout")}
							</button>
						</li>
					</ul>
				</div>
			</details>

			{bio && (
				<p class="account-bio truncate" style={{ "--lines": "5" }} title={bio}>
					{bio}
				</p>
			)}

			<button type="button" class="account-key" onClick={handleCopyKey} title={t("account.copyKeyAria")}>
				<span class="truncate">{shortNpub(id)}</span>
				<IconCopy />
			</button>

			{degraded && <p class="account-alert">{t(relay.labelKey)}</p>}
		</div>
	);
}
