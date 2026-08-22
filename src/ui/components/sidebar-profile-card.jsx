import { useState, useEffect } from "preact/hooks";
import { currentUser, lock } from "../signals/auth.js";
import { profileActivity } from "../signals/profile.js";
import { getProfile } from "../../core/crypto/keystore.js";
import { resolveEffectiveTheme } from "../theme/theme-mode.js";
import AccountAvatar from "./account-avatar.jsx";
import ImageModal from "./image-modal.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";
import IconFolder from "../icons/folder.jsx";
import IconGear from "../icons/gear.jsx";
import IconPerson from "../icons/person.jsx";
import IconSun from "../icons/sun.jsx";
import IconMoon from "../icons/moon.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import IconHelpCircle from "../icons/help-circle.jsx";
import IconActivityLog from "../icons/activity-log.jsx";
import IconExit from "../icons/exit.jsx";
import IconTrash from "../icons/trash.jsx";
import IconDotsVertical from "../icons/dots-vertical.jsx";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import { t } from "../signals/i18n.js";

// Постоянная карточка "кто я" в aside — видна на любом внутреннем экране, не
// только на вкладке "Профиль" (решение пользователя). Данные из того же
// keystore, что profile.jsx — profileActivity синхронизирует карточку с
// правками, сделанными там (тот же приём, что messagingActivity в chats.js).
export default function SidebarProfileCard({ onEditProfile, onOpenStorage, onOpenSettings, onOpenHelp, onOpenDiagnostics, themeMode, onToggleTheme }) {
	const id = currentUser.value.id;
	const login = currentUser.value.login;
	const [avatar, setAvatar] = useState("");
	const [avatarUrl, setAvatarUrl] = useState("");
	const [bio, setBio] = useState("");
	const [showAvatarModal, setShowAvatarModal] = useState(false);
	// Редизайн интерфейса, этап 9 (CONTRACTS.md) — "Хранилище" переехало сюда
	// из основного списка разделов. Задел этапа 10 (шаг 10.2): тот же
	// <details class="menu">/useDetailsMenu, что ActionsMenu/AddToGroupControl
	// везде в проекте — этап 10 добавит остальные пункты (профиль/настройки/
	// тема/etc.) в ЭТОТ ЖЕ menu__pop, не строя новый механизм с нуля.
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
		<section class="profile-card stack" style={{ "--gap": "var(--space-s)" }} aria-label={t("sidebarCard.profileAria")}>
			{/* Пользователь: "аватар строго квадратным, при клике — полная
			    фотография в модальном окне" — кликабелен только если фото
			    реально есть, заглушка-буква никуда не ведёт (disabled).
			    avatarUrl — фолбэк на публичный Blossom URL, когда локального
			    data-url кэша ещё нет (новое устройство после hydrateOwnProfile,
			    profile.js) — тот же приём, что profile.jsx.
			    Этап 74 — Часть B, T6.3: приоритет avatar||avatarUrl НЕ менять —
			    корректность обеспечивает инвалидация в hydrateOwnProfile (T6.1),
			    не порядок здесь. */}
			<button
				type="button"
				class="profile-card-avatar-btn"
				onClick={() => setShowAvatarModal(true)}
				disabled={!avatar && !avatarUrl}
				aria-label={avatar || avatarUrl ? t("sidebarCard.openPhotoAria") : undefined}
			>
				<AccountAvatar avatar={avatar || avatarUrl} login={login || id} large />
				{/* VISUAL.md v2 — "стеклянная" подсказка: лупа проявляется снизу по
				    hover/фокусу, намекая на кликабельность. Только когда фото
				    реально есть — для заглушки-буквы кликать некуда. */}
				{(avatar || avatarUrl) && (
					<span class="profile-card-avatar-glass row" style={{ alignItems: "flex-end", justifyContent: "center" }} aria-hidden="true">
						<IconMagnifyingGlass />
					</span>
				)}
			</button>
			<div class="profile-card-body">
				<h2 class="row" style={{ "--gap": "var(--space-3xs)", alignItems: "center", justifyContent: "space-between", flexWrap: "nowrap" }}>
					{/* Редизайн интерфейса, этап 9 — flex:1+min-width:0+ellipsis: до
					    второй кнопки (карандаш) хватало места без этого, но третья
					    (меню "Хранилище") стала переполнять узкую 240px-колонку и
					    ПЕРЕНОСИЛАСЬ на новую строку (.row — flex-wrap:wrap по
					    умолчанию) — details.menu на новой строке считал inset-inline-end
					    от СВОЕЙ, а не общей ширины, попап уезжал за левый край aside
					    (overflow:auto — обрезался, найдено живой проверкой Chrome). */}
					<span title={login || id} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
						{login || id.slice(0, 16) + "…"}
					</span>
					{/* Едва видима (opacity 0.2), проявляется по hover/focus на всей
					    карточке (.profile-card) — рядом с именем, не отдельной
					    строкой снизу. */}
					<button type="button" class="icon-btn profile-edit-btn" onClick={onEditProfile} aria-label={t("sidebarCard.editProfileButton")}>
						<IconPencil />
					</button>
					{/* Редизайн интерфейса, этап 10.2 (CONTRACTS.md) — расширение
					    того же <details class="menu">, что этап 9 завёл под один
					    пункт "Хранилище". Большинство пунктов ведут на ОДИН и тот же
					    экран "Настройки" (там уже живут MnemonicReveal/
					    DeleteAccountPanel) — решение задокументировано в
					    CONTRACTS.md, не выдумывать несуществующие отдельные экраны
					    ради формального соответствия количеству пунктов макета. */}
					<details class="menu" ref={menuRef} onClick={handleMenuClick}>
						<summary class="icon-btn" aria-label={t("sidebarCard.accountMenuAria")}>
							<IconDotsVertical />
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
				</h2>
				{/* Декоративные кавычки вокруг био (пользователь предложил идею
				    сам) — акцентным цветом-компаньоном (--accent-2/draught),
				    тихо, без рамок вокруг всего блока. */}
				{bio && <p class="profile-bio">{bio}</p>}
			</div>
			{showAvatarModal && (avatar || avatarUrl) && <ImageModal src={avatar || avatarUrl} alt={t("sidebarCard.photoAlt")} onClose={() => setShowAvatarModal(false)} />}
		</section>
	);
}
