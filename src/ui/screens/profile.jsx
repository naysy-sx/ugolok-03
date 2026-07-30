import { useState, useEffect, useRef } from "preact/hooks";
import { npubEncode } from "nostr-tools/nip19";
import { getProfile, updateProfile } from "../../core/crypto/keystore.js";
import { buildProfileEvent } from "../../domain/identity/profile.js";
import { uploadAvatarBlob } from "../../domain/attachments/upload.js";
import { getManifest, getRange } from "../../domain/files/content.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, reconnectWithNewSettings } from "../signals/transport.js";
import { projected, getFileKeyFor } from "../signals/files.js";
import {
	loadUiSettings,
	addRelayUrl,
	removeRelayUrl,
	setActiveRelayUrl,
	addBlossomUrl,
	removeBlossomUrl,
	setActiveBlossomUrl,
} from "../../domain/settings/ui-settings.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import Screen from "../components/screen.jsx";
import FilePicker from "../components/file-picker.jsx";
import { bumpProfileActivity } from "../signals/profile.js";
import IconCopy from "../icons/copy.jsx";
import IconTrash from "../icons/trash.jsx";
import IconPlus from "../icons/plus.jsx";

const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

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
		<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }} aria-labelledby={`srv-${title}`}>
			<h2 id={`srv-${title}`} class="sect-title">
				{title}
			</h2>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			<ul role="list" class="srv__list">
				{urls.map((url) => (
					<li key={url} class="srv__item">
						<span class="srv__url">{url}</span>
						{url === activeUrl && <span class="badge-on">активный</span>}
						{url !== activeUrl && (
							<button type="button" class="btn--ghost" disabled={busy} onClick={() => runAction(() => onSetActive(url))}>
								Сделать активным
							</button>
						)}
						<button
							type="button"
							class="icon-btn"
							disabled={busy}
							onClick={() => runAction(() => onRemove(url))}
							aria-label={`Удалить сервер ${url}`}
						>
							<IconTrash />
						</button>
					</li>
				))}
				{urls.length === 0 && (
					<li style={{ color: "var(--muted)" }} class="srv__item">
						Список пуст.
					</li>
				)}
			</ul>
			<form class="srv__add" onSubmit={handleAdd}>
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
				<button type="submit" class="btn--ghost" disabled={busy || !newUrl.trim()}>
					<IconPlus /> Добавить
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
	const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
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

	// Общий хвост обоих источников аватара (с диска/из хранилища) — публикация
	// ПУБЛИЧНОЙ незашифрованной копии (этап 37) + republish kind 0. Best-effort
	// (та же философия, что handleBioSubmit): локальное превью/кэш НЕ зависит
	// от публикации.
	async function publishAvatarBytes(fileBytes, mimeType) {
		setPublishStatus("публикация…");
		try {
			const settings = await loadUiSettings(id, dbKeySig.value);
			const serverUrl = settings.activeBlossomUrl;
			if (!serverUrl) {
				setPublishStatus("не опубликовано для других: нет активного Blossom-сервера");
				return;
			}
			await ensureConnected(id, privKeySig.value, dbKeySig.value);
			const url = await uploadAvatarBlob(serverUrl, fileBytes, mimeType, privKeySig.value);
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
		const fileBytes = new Uint8Array(await file.arrayBuffer());
		await publishAvatarBytes(fileBytes, file.type);
	}

	// И7 7.2 — аватар ИЗ ХРАНИЛИЩА (FilePicker, §5.7 TASK.md). В отличие от
	// "Заменить" (файл с диска, никогда не был приватным), файл ИЗ "Файлы"
	// сейчас зашифрован — становясь аватаром, он публикуется НЕЗАШИФРОВАННЫМ
	// НАВСЕГДА (решение №8 TASK.md, §7: "изображение станет общедоступным
	// незашифрованным"). window.confirm() — то же решение, что необратимые
	// действия в files.jsx (Удалить/unmountShare, этап 53 И3/И6) — простой
	// нативный диалог, не кастомная модалка ради одного текста.
	async function handleAvatarFromStorage([nodeId]) {
		setAvatarPickerOpen(false);
		setAvatarError("");
		const node = projected.value.nodes.get(nodeId);
		if (!node || node.kind !== "file") return;
		try {
			const manifest = await getManifest(node.blob, { serverUrl: BLOSSOM_URL });
			if (!manifest.mime?.startsWith("image/")) {
				setAvatarError("Выберите файл изображения.");
				return;
			}
			if (manifest.size > MAX_AVATAR_BYTES) {
				setAvatarError("Файл слишком большой (максимум 2 МБ).");
				return;
			}
			const fileKey = await getFileKeyFor(node.blob);
			if (!fileKey) {
				setAvatarError("Ключ файла не найден — возможно, файл ещё не полностью синхронизирован.");
				return;
			}
			if (!window.confirm("Изображение станет общедоступным и больше не будет зашифровано. Продолжить?")) return;
			const bytes = await getRange(manifest, fileKey, 0, manifest.size, { serverUrl: BLOSSOM_URL });
			const dataUrl = await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result);
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(new Blob([bytes], { type: manifest.mime }));
			});
			setAvatar(dataUrl);
			await updateProfile(id, { avatar: dataUrl });
			bumpProfileActivity();
			await publishAvatarBytes(bytes, manifest.mime);
		} catch (err) {
			setAvatarError(err?.message || String(err));
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
				<h2 id="profile-npub-heading" class="sect-title">
					Ваш идентификатор
				</h2>
				<div class="keybox">
					<code>{npubEncode(id)}</code>
					<button type="button" class="icon-btn" onClick={handleCopyNpub} aria-label="Скопировать ключ">
						<IconCopy />
					</button>
				</div>
				{copyStatus && (
					<p role="status" style={{ color: "var(--muted)" }}>
						{copyStatus}
					</p>
				)}
				<p class="hint">Вот этот ключ вы можете использовать, чтобы другие пользователи могли вас добавить.</p>
			</section>

			{/* Пользователь: "перекомпоновать блоки с аватаром и о себе — две
			    колонки: в первой маленькой квадратный аватар и кнопка 'Заменить'
			    внизу, во второй большой — блок 'О себе'". aria-label вместо
			    видимого <h2> "Аватар" — левая колонка теперь читается сама по
			    себе (фото + кнопка под ним), а "О себе" остаётся единственным
			    видимым заголовком блока. */}
			<div class="profile-photo-layout">
				<div class="profile-photo-col" aria-label="Аватар">
					{/* avatarUrl (публичный Blossom URL) — фолбэк, когда локального
					    data-url кэша ещё нет: НОВОЕ устройство подтягивает bio/avatarUrl
					    из своего же kind 0 при bootstrap (hydrateOwnProfile, profile.js),
					    но avatar (сам файл как data-url) — только через локальную загрузку;
					    без фолбэка аватар выглядел бы пустым до первой замены на новом
					    устройстве, хотя публичная копия уже известна. */}
					{avatar || avatarUrl ? (
						<img src={avatar || avatarUrl} alt="" class="profile-avatar-square" />
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
					<button type="button" class="btn--ghost" onClick={() => setAvatarPickerOpen(true)}>
						Выбрать из хранилища
					</button>
					{avatarError && (
						<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
							{avatarError}
						</p>
					)}
				</div>
				{avatarPickerOpen && (
					<FilePicker predicate={(node) => node.kind === "file"} multiple={false} onSelect={handleAvatarFromStorage} onCancel={() => setAvatarPickerOpen(false)} />
				)}

				<form class="flow profile-bio-col" onSubmit={handleBioSubmit}>
					<fieldset class="flow">
						<legend class="sect-title">О себе</legend>
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
				<h2 id="profile-files-heading" class="sect-title">
					Файлы
				</h2>
				<div class="files-empty">Загрузка и управление файлами появится позже.</div>
			</section>

			<RelayBlossomSection ownerPubkey={id} privKey={privKeySig.value} dbKey={dbKeySig.value} />
		</Screen>
	);
}
