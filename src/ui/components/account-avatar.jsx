// Общий аватар для стартового экрана (unlock.jsx) — до входа в аккаунт другого
// источника, кроме локального превью (keystore's avatar, data:URL), нет: Blossom-URL
// профиля появляется только ПОСЛЕ входа (profile.jsx). Без фото — заглушка с первой
// буквой логина, тот же приём, что ContactIdentity (contacts.jsx) внутри приложения.
// ASIDE-REDESIGN/SIDEBAR-SPEC.md, этап 2 — один класс, размер переменной
// (--avatar), не три класса (account-avatar/-sm/-large) плюс разводящее
// .app-layout .account-avatar-sm, нужное только потому, что три имени
// конфликтовали между собой.
export default function AccountAvatar({ avatar, login, large, small }) {
	const size = large ? "var(--avatar-l)" : small ? "var(--avatar-s)" : "var(--avatar-m)";
	if (avatar) {
		return <img src={avatar} alt="" class="account-avatar" style={{ "--avatar": size }} />;
	}
	return (
		<div class="account-avatar account-avatar-fallback row" style={{ "--avatar": size, "--align": "center", justifyContent: "center" }} aria-hidden="true">
			{(login || "?").trim().charAt(0).toUpperCase()}
		</div>
	);
}
