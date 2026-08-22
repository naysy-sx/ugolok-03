import { useState, useEffect } from "preact/hooks";
import { currentUser, lock } from "../signals/auth.js";
import { profileActivity } from "../signals/profile.js";
import { getProfile } from "../../core/crypto/keystore.js";
import { resolveEffectiveTheme } from "../theme/theme-mode.js";
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
import IconTrash from "../icons/trash.jsx";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import { t } from "../signals/i18n.js";

// Идентити-карточка сайдбара — разметка по макету (PROCESS-DOCS/REDESIGN/
// ugolok-final.html, .idwrap/.idcard__btn/.idmenu): вся строка (аватар+имя+
// био+шеврон) — ОДИН <summary>-триггер выпадающего меню, не два отдельных
// клик-таргета (карандаш-редактирование + отдельная кнопка меню), как было
// раньше (этап 9/10.2) — макет показывает ровно одну цель клика на всю
// карточку. Отдельная "лупа по клику на фото" (было) убрана вместе с ней:
// то же самое фото уже видно крупно на экране "Профиль" (пункт меню ниже),
// не теряется, просто на клик дальше, как в макете.
export default function SidebarProfileCard({ onEditProfile, onOpenStorage, onOpenSettings, onOpenHelp, onOpenDiagnostics, themeMode, onToggleTheme }) {
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

	return (
		<details class="menu idwrap" ref={menuRef} onClick={handleMenuClick} aria-label={t("sidebarCard.profileAria")}>
			<summary class="idcard__btn bar" style={{ "--gap": "var(--space-xs)", alignItems: "center" }}>
				<AccountAvatar avatar={avatar || avatarUrl} login={login || id} small />
				<span class="idcard__body stack grow" style={{ "--gap": "0" }}>
					<span class="idcard__name truncate" title={login || id}>
						{login || id.slice(0, 16) + "…"}
					</span>
					{bio && (
						<span class="idcard__bio truncate" title={bio}>
							{bio}
						</span>
					)}
				</span>
				{/* Текстовый глиф, не SVG — та же экономия, что PinToggle (⚑/⚐,
				    nav-groups.jsx) и сам макет (буквально "▾" в разметке). */}
				<span class="chev" aria-hidden="true">
					▾
				</span>
			</summary>
			<div class="menu__pop stack" style={{ "--gap": "2px" }}>
				<button type="button" onClick={onEditProfile}>
					<IconPerson /> {t("sidebarCard.menuProfile")}
				</button>
				<button type="button" onClick={onOpenSettings}>
					<IconGear /> {t("sidebarCard.menuSettings")}
				</button>
				<button type="button" onClick={onToggleTheme}>
					{resolveEffectiveTheme(themeMode) === "dark" ? <IconSun /> : <IconMoon />} {t("sidebarCard.menuTheme")}
					<span class="menu-item-hint">{resolveEffectiveTheme(themeMode) === "dark" ? t("themeStatus.dark") : t("themeStatus.light")}</span>
				</button>
				<div class="sep" />
				<button type="button" onClick={onOpenSettings}>
					<IconLockClosed /> {t("sidebarCard.menuMnemonic")}
				</button>
				<button type="button" onClick={onOpenSettings}>
					<IconLockClosed /> {t("sidebarCard.menuRecover")}
				</button>
				<div class="sep" />
				<button type="button" onClick={onOpenStorage}>
					<IconFolder /> {t("sidebarCard.storageMenuItem")}
				</button>
				<button type="button" onClick={onOpenHelp}>
					<IconHelpCircle /> {t("sidebarCard.menuHelp")}
				</button>
				<button type="button" onClick={onOpenDiagnostics}>
					<IconActivityLog /> {t("sidebarCard.menuDiagnostics")}
				</button>
				<div class="sep" />
				<button type="button" onClick={lock}>
					<IconExit /> {t("shell.logout")}
				</button>
				<button type="button" class="danger" onClick={onOpenSettings}>
					<IconTrash /> {t("sidebarCard.menuDeleteAccount")}
				</button>
			</div>
		</details>
	);
}
