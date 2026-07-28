import { useState, useEffect } from "preact/hooks";
import { currentUser } from "../signals/auth.js";
import { profileActivity } from "../signals/profile.js";
import { getProfile } from "../../core/crypto/keystore.js";
import AccountAvatar from "./account-avatar.jsx";
import ImageModal from "./image-modal.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";

// Постоянная карточка "кто я" в aside — видна на любом внутреннем экране, не
// только на вкладке "Профиль" (решение пользователя). Данные из того же
// keystore, что profile.jsx — profileActivity синхронизирует карточку с
// правками, сделанными там (тот же приём, что messagingActivity в chats.js).
export default function SidebarProfileCard({ onEditProfile }) {
	const id = currentUser.value.id;
	const login = currentUser.value.login;
	const [avatar, setAvatar] = useState("");
	const [avatarUrl, setAvatarUrl] = useState("");
	const [bio, setBio] = useState("");
	const [showAvatarModal, setShowAvatarModal] = useState(false);

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
		<section class="profile-card" aria-label="Профиль пользователя">
			{/* Пользователь: "аватар строго квадратным, при клике — полная
			    фотография в модальном окне" — кликабелен только если фото
			    реально есть, заглушка-буква никуда не ведёт (disabled).
			    avatarUrl — фолбэк на публичный Blossom URL, когда локального
			    data-url кэша ещё нет (новое устройство после hydrateOwnProfile,
			    profile.js) — тот же приём, что profile.jsx. */}
			<button
				type="button"
				class="profile-card-avatar-btn"
				onClick={() => setShowAvatarModal(true)}
				disabled={!avatar && !avatarUrl}
				aria-label={avatar || avatarUrl ? "Открыть фото профиля" : undefined}
			>
				<AccountAvatar avatar={avatar || avatarUrl} login={login || id} large />
				{/* VISUAL.md v2 — "стеклянная" подсказка: лупа проявляется снизу по
				    hover/фокусу, намекая на кликабельность. Только когда фото
				    реально есть — для заглушки-буквы кликать некуда. */}
				{(avatar || avatarUrl) && (
					<span class="profile-card-avatar-glass" aria-hidden="true">
						<IconMagnifyingGlass />
					</span>
				)}
			</button>
			<div class="profile-card-body">
				<h2>
					<span title={login || id}>{login || id.slice(0, 16) + "…"}</span>
				</h2>
				{/* Декоративные кавычки вокруг био (пользователь предложил идею
				    сам) — акцентным цветом-компаньоном (--accent-2/draught),
				    тихо, без рамок вокруг всего блока. */}
				{bio && <p class="profile-bio">{bio}</p>}
				{/* Найдено пользователем: иконка-карандаш рядом с именем в узкой
				    колонке h2 (флекс-строка с truncate-именем) пряталась у самого
				    края сайдбара — фактически невидима/некликабельна. Своя строка
				    ниже, с подписью — надёжнее компактной иконки-без-текста. */}
				<button type="button" class="profile-edit-btn" onClick={onEditProfile}>
					<IconPencil /> Изменить профиль
				</button>
			</div>
			{showAvatarModal && (avatar || avatarUrl) && <ImageModal src={avatar || avatarUrl} alt="Фото профиля" onClose={() => setShowAvatarModal(false)} />}
		</section>
	);
}
