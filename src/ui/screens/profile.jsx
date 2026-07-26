import { useState, useEffect, useRef } from "preact/hooks";
import { npubEncode } from "nostr-tools/nip19";
import { getProfile, updateProfile } from "../../core/crypto/keystore.js";
import { buildProfileEvent } from "../../domain/identity/profile.js";
import { uploadAvatarBlob } from "../../domain/attachments/upload.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, reconnectWithNewSettings } from "../signals/transport.js";
import {
	loadUiSettings,
	addRelayUrl,
	removeRelayUrl,
	setActiveRelayUrl,
	addBlossomUrl,
	removeBlossomUrl,
	setActiveBlossomUrl,
} from "../../domain/settings/ui-settings.js";
import Screen from "../components/screen.jsx";
import { bumpProfileActivity } from "../signals/profile.js";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function readFileAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

// CONTRACTS.md, этап 34 — пользователь: "в профиль необходимо добавить возможность
// добавления и переключения на другие relay сервера". Blossom — тот же паттерн, без
// переподключения (URL читается per-upload, не держит постоянное соединение).
function ServerListEditor({ title, urlPlaceholder, urls, activeUrl, onAdd, onRemove, onSetActive, busy }) {
	const [newUrl, setNewUrl] = useState("");
	const [error, setError] = useState("");

	async function handleAdd(e) {
		e.preventDefault();
		const trimmed = newUrl.trim();
		if (!trimmed) return;
		setError("");
		try {
			await onAdd(trimmed);
			setNewUrl("");
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	async function runAction(fn) {
		setError("");
		try {
			await fn();
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	return (
		<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
			<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{title}</h2>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }} class="flow">
				{urls.map((url) => (
					<li key={url} class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
						<span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
							{url} {url === activeUrl && <strong>(активный)</strong>}
						</span>
						<span class="cluster">
							{url !== activeUrl && (
								<button type="button" disabled={busy} onClick={() => runAction(() => onSetActive(url))}>
									Сделать активным
								</button>
							)}
							<button type="button" disabled={busy} onClick={() => runAction(() => onRemove(url))}>
								Удалить
							</button>
						</span>
					</li>
				))}
				{urls.length === 0 && <li style={{ color: "var(--muted)" }}>Список пуст.</li>}
			</ul>
			<form class="cluster" onSubmit={handleAdd}>
				<label class="visually-hidden" for={`${title}-new-url`}>
					Добавить сервер
				</label>
				<input
					id={`${title}-new-url`}
					type="text"
					placeholder={urlPlaceholder}
					value={newUrl}
					onInput={(e) => setNewUrl(e.currentTarget.value)}
				/>
				<button type="submit" disabled={busy || !newUrl.trim()}>
					Добавить
				</button>
			</form>
		</section>
	);
}

function RelayBlossomSection({ ownerPubkey, privKey, dbKey }) {
	const [settings, setSettings] = useState(null);
	const [busy, setBusy] = useState(false);

	async function refresh() {
		setSettings(await loadUiSettings(ownerPubkey, dbKey));
	}

	useEffect(() => {
		refresh().catch(() => {});
	}, [ownerPubkey]);

	async function withBusy(fn) {
		setBusy(true);
		try {
			await fn();
			await refresh();
		} finally {
			setBusy(false);
		}
	}

	if (!settings) return null;

	return (
		<div class="flow" style={{ "--flow-space": "var(--space-m)" }}>
			<ServerListEditor
				title="Relay-серверы"
				urlPlaceholder="wss://relay.example.com"
				urls={settings.relayUrls}
				activeUrl={settings.activeRelayUrl}
				busy={busy}
				onAdd={(url) => withBusy(() => addRelayUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onRemove={(url) => withBusy(() => removeRelayUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onSetActive={(url) =>
					withBusy(async () => {
						await setActiveRelayUrl(ownerPubkey, privKey, dbKey, url, publish);
						await reconnectWithNewSettings(ownerPubkey, privKey, dbKeySig.value);
					})
				}
			/>
			<ServerListEditor
				title="Blossom-серверы (файлы/вложения)"
				urlPlaceholder="https://blossom.example.com"
				urls={settings.blossomUrls}
				activeUrl={settings.activeBlossomUrl}
				busy={busy}
				onAdd={(url) => withBusy(() => addBlossomUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onRemove={(url) => withBusy(() => removeBlossomUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onSetActive={(url) => withBusy(() => setActiveBlossomUrl(ownerPubkey, privKey, dbKey, url, publish))}
			/>
		</div>
	);
}

export default function Profile() {
	const id = currentUser.value.id;
	const login = currentUser.value.login;

	const [loading, setLoading] = useState(true);
	const [avatar, setAvatar] = useState("");
	const [avatarUrl, setAvatarUrl] = useState("");
	const [bio, setBio] = useState("");
	const [savedBio, setSavedBio] = useState("");
	const [bioStatus, setBioStatus] = useState("");
	const [publishStatus, setPublishStatus] = useState("");
	const [avatarError, setAvatarError] = useState("");
	const [copyStatus, setCopyStatus] = useState("");
	const statusTimerRef = useRef(null);
	const copyTimerRef = useRef(null);

	useEffect(() => {
		(async () => {
			const profile = await getProfile(id);
			setAvatar(profile.avatar);
			setAvatarUrl(profile.avatarUrl);
			setBio(profile.bio);
			setSavedBio(profile.bio);
			setLoading(false);
		})();
		return () => {
			clearTimeout(statusTimerRef.current);
			clearTimeout(copyTimerRef.current);
		};
	}, [id]);

	async function handleCopyNpub() {
		try {
			await navigator.clipboard.writeText(npubEncode(id));
			setCopyStatus("Скопировано");
		} catch {
			setCopyStatus("Не удалось скопировать — скопируйте вручную");
		}
		clearTimeout(copyTimerRef.current);
		copyTimerRef.current = setTimeout(() => setCopyStatus(""), 2000);
	}

	async function handleAvatarChange(e) {
		const input = e.currentTarget;
		const file = input.files?.[0];
		if (!file) return;
		if (!file.type.startsWith("image/")) {
			setAvatarError("Выберите файл изображения.");
			input.value = "";
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			setAvatarError("Файл слишком большой (максимум 2 МБ).");
			input.value = "";
			return;
		}
		setAvatarError("");
		const dataUrl = await readFileAsDataUrl(file);
		setAvatar(dataUrl);
		await updateProfile(id, { avatar: dataUrl });
		bumpProfileActivity();
		input.value = "";

		// Best-effort (та же философия, что handleBioSubmit): локальное превью/кэш
		// НЕ зависит от публикации. Аватар — публичный профиль, не сообщение,
		// поэтому загружается БЕЗ шифрования (uploadAvatarBlob, этап 37).
		setPublishStatus("публикация…");
		try {
			const settings = await loadUiSettings(id, dbKeySig.value);
			const serverUrl = settings.activeBlossomUrl;
			if (!serverUrl) {
				setPublishStatus("не опубликовано для других: нет активного Blossom-сервера");
				return;
			}
			const fileBytes = new Uint8Array(await file.arrayBuffer());
			await ensureConnected(id, privKeySig.value, dbKeySig.value);
			const url = await uploadAvatarBlob(serverUrl, fileBytes, file.type, privKeySig.value);
			// Персистируем ПУБЛИЧНЫЙ URL отдельно от dataUrl-превью (этап 38-довесок) —
			// без этого handleBioSubmit не смогла бы включить picture в свой republish
			// и молча стирала бы уже опубликованный аватар при следующем сохранении био.
			setAvatarUrl(url);
			await updateProfile(id, { avatarUrl: url });
			// savedBio (не текущий черновик bio) — republish не должен затирать уже
			// опубликованное био незасабмиченным черновиком в поле ввода.
			const event = buildProfileEvent(privKeySig.value, { name: login, about: savedBio, picture: url });
			const result = await publish(event);
			setPublishStatus(result.ok ? "" : "не опубликовано для других: " + (result.reason || "relay отклонил"));
		} catch (err) {
			setPublishStatus("не опубликовано для других: " + (err?.message || String(err)));
		}
	}

	async function handleBioSubmit(e) {
		e.preventDefault();
		await updateProfile(id, { bio });
		bumpProfileActivity();
		setSavedBio(bio);
		setBioStatus("Сохранено");
		clearTimeout(statusTimerRef.current);
		statusTimerRef.current = setTimeout(() => setBioStatus(""), 2000);

		// Локальное сохранение НЕ зависит от публикации (профиль в этом экране —
		// keystore-запись, не fold из журнала событий, в отличие от contacts/groups) —
		// публикация в relay отдельный, best-effort шаг: другие пользователи видят
		// никнейм/био через kind 0 (F-CT-04), но офлайн-редактирование остаётся рабочим.
		setPublishStatus("публикация…");
		try {
			await ensureConnected(id, privKeySig.value, dbKeySig.value);
			// avatarUrl (этап 38-довесок, найденный реальным использованием баг): БЕЗ
			// него этот republish стирал бы уже опубликованный аватар — kind 0
			// replaceable, отсутствие поля в новой версии = "поля больше нет".
			const event = buildProfileEvent(privKeySig.value, { name: login, about: bio, picture: avatarUrl || undefined });
			const result = await publish(event);
			setPublishStatus(result.ok ? "" : "не опубликовано для других: " + (result.reason || "relay отклонил"));
		} catch (err) {
			setPublishStatus("не опубликовано для других: " + (err?.message || String(err)));
		}
	}

	if (loading) {
		return (
			<Screen title="Профиль">
				<p style={{ color: "var(--muted)" }}>Загрузка профиля…</p>
			</Screen>
		);
	}

	const initial = (login || "?").trim().charAt(0).toUpperCase() || "?";
	const bioIsDirty = bio !== savedBio;

	return (
		<Screen title={login || "Без имени"}>
			<section class="flow" aria-labelledby="profile-npub-heading">
				<h2 id="profile-npub-heading">Ваш идентификатор</h2>
				<p class="cluster" style={{ alignItems: "center" }}>
					<code
						role="button"
						tabIndex="0"
						onClick={handleCopyNpub}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								handleCopyNpub();
							}
						}}
						title="Нажмите, чтобы скопировать"
						style={{
							cursor: "pointer",
							wordBreak: "break-all",
							padding: "var(--space-3xs) var(--space-2xs)",
							background: "var(--surface)",
							borderRadius: "var(--radius)",
						}}
					>
						{npubEncode(id)}
					</code>
					{copyStatus && (
						<span role="status" style={{ color: "var(--muted)" }}>
							{copyStatus}
						</span>
					)}
				</p>
				<small style={{ color: "var(--muted)" }}>
					Вот этот ключ вы можете использовать, чтобы другие пользователи могли вас добавить.
				</small>
			</section>

			{/* Пользователь: "перекомпоновать блоки с аватаром и о себе — две
			    колонки: в первой маленькой квадратный аватар и кнопка 'Заменить'
			    внизу, во второй большой — блок 'О себе'". aria-label вместо
			    видимого <h2> "Аватар" — левая колонка теперь читается сама по
			    себе (фото + кнопка под ним), а "О себе" остаётся единственным
			    видимым заголовком блока. */}
			<div class="profile-photo-layout">
				<div class="profile-photo-col" aria-label="Аватар">
					{avatar ? (
						<img src={avatar} alt="" class="profile-avatar-square" />
					) : (
						<div role="img" aria-label="Аватар не задан" class="profile-avatar-square profile-avatar-square-fallback">
							{initial}
						</div>
					)}
					<label for="profile-avatar-input" class="profile-avatar-replace-btn">
						Заменить
					</label>
					<input
						id="profile-avatar-input"
						class="visually-hidden"
						type="file"
						accept="image/*"
						onChange={handleAvatarChange}
					/>
					{avatarError && (
						<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
							{avatarError}
						</p>
					)}
				</div>

				<form class="flow profile-bio-col" onSubmit={handleBioSubmit}>
					<fieldset class="flow">
						<legend>О себе</legend>
						<label for="profile-bio">Био</label>
						<textarea
							id="profile-bio"
							rows="4"
							value={bio}
							onInput={(e) => setBio(e.currentTarget.value)}
						/>
					</fieldset>
					<div class="cluster">
						<button type="submit" disabled={!bioIsDirty}>
							Сохранить
						</button>
						{bioStatus && (
							<span role="status" style={{ color: "var(--muted)" }}>
								{bioStatus}
							</span>
						)}
						{publishStatus && (
							<span role="status" style={{ color: "var(--muted)" }}>
								{publishStatus}
							</span>
						)}
					</div>
				</form>
			</div>

			<section class="flow" aria-labelledby="profile-files-heading">
				<h2 id="profile-files-heading">Файлы</h2>
				<p style={{ color: "var(--muted)" }}>
					Загрузка и управление файлами появится позже.
				</p>
				<label for="profile-files-input">Добавить файлы</label>
				<input id="profile-files-input" type="file" multiple disabled />
			</section>

			<RelayBlossomSection ownerPubkey={id} privKey={privKeySig.value} dbKey={dbKeySig.value} />
		</Screen>
	);
}
