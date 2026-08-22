// Общий аватар для стартового экрана (unlock.jsx) — до входа в аккаунт другого
// источника, кроме локального превью (keystore's avatar, data:URL), нет: Blossom-URL
// профиля появляется только ПОСЛЕ входа (profile.jsx). Без фото — заглушка с первой
// буквой логина, тот же приём, что ContactIdentity (contacts.jsx) внутри приложения.
// small — компактный вариант (идентити-карточка сайдбара, разметка по
// макету ugolok-final.html: .ava, 40px) — третий размер рядом с обычным
// (unlock.jsx account-picker) и large (unlock.jsx/sidebar-card, было).
export default function AccountAvatar({ avatar, login, large, small }) {
	const sizeClass = large ? "account-avatar-large" : small ? "account-avatar-sm" : "account-avatar";
	if (avatar) {
		return <img src={avatar} alt="" class={sizeClass} />;
	}
	return (
		<div class={`${sizeClass} account-avatar-fallback row`} style={{ alignItems: "center", justifyContent: "center" }} aria-hidden="true">
			{(login || "?").trim().charAt(0).toUpperCase()}
		</div>
	);
}
