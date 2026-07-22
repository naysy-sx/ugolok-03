import { useState, useEffect } from "preact/hooks";
import { currentUser } from "../signals/auth.js";
import { profileActivity } from "../signals/profile.js";
import { getProfile } from "../../core/crypto/keystore.js";
import AccountAvatar from "./account-avatar.jsx";

// Постоянная карточка "кто я" в aside — видна на любом внутреннем экране, не
// только на вкладке "Профиль" (решение пользователя). Данные из того же
// keystore, что profile.jsx — profileActivity синхронизирует карточку с
// правками, сделанными там (тот же приём, что messagingActivity в chats.js).
export default function SidebarProfileCard({ onEditProfile }) {
	const id = currentUser.value.id;
	const login = currentUser.value.login;
	const [avatar, setAvatar] = useState("");
	const [bio, setBio] = useState("");

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
			<AccountAvatar avatar={avatar} login={login || id} large />
			<div class="profile-card-body">
				<h2>{login || id.slice(0, 16) + "…"}</h2>
				{bio && <p>{bio}</p>}
			</div>
			<button type="button" class="btn-link" onClick={onEditProfile}>
				Изменить профиль
			</button>
		</section>
	);
}
