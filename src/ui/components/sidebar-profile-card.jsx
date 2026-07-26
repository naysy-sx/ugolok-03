import { useState, useEffect } from "preact/hooks";
import { currentUser } from "../signals/auth.js";
import { profileActivity } from "../signals/profile.js";
import { getProfile } from "../../core/crypto/keystore.js";
import AccountAvatar from "./account-avatar.jsx";
import ImageModal from "./image-modal.jsx";
import IconPencil from "../icons/pencil.jsx";

// Постоянная карточка "кто я" в aside — видна на любом внутреннем экране, не
// только на вкладке "Профиль" (решение пользователя). Данные из того же
// keystore, что profile.jsx — profileActivity синхронизирует карточку с
// правками, сделанными там (тот же приём, что messagingActivity в chats.js).
export default function SidebarProfileCard({ onEditProfile }) {
	const id = currentUser.value.id;
	const login = currentUser.value.login;
	const [avatar, setAvatar] = useState("");
	const [bio, setBio] = useState("");
	const [showAvatarModal, setShowAvatarModal] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getProfile(id).then((profile) => {
			if (cancelled) return;
			setAvatar(profile.avatar);
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
			    реально есть, заглушка-буква никуда не ведёт (disabled). */}
			<button
				type="button"
				class="profile-card-avatar-btn"
				onClick={() => setShowAvatarModal(true)}
				disabled={!avatar}
				aria-label={avatar ? "Открыть фото профиля" : undefined}
			>
				<AccountAvatar avatar={avatar} login={login || id} large />
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
			{showAvatarModal && avatar && <ImageModal src={avatar} alt="Фото профиля" onClose={() => setShowAvatarModal(false)} />}
		</section>
	);
}
