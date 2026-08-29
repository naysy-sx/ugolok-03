import { useState, useEffect, useRef, useId } from "preact/hooks";
import { npubEncode } from "nostr-tools/nip19";
import { getProfile, updateProfile } from "../../core/crypto/keystore.js";
import { buildProfileEvent, uploadAvatarBlob } from "../../domain/identity/profile.js";
import { getManifest, getRange } from "../../domain/files/content.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish } from "../signals/transport.js";
import { projected, getFileKeyFor } from "../signals/files.js";
import { loadUiSettings } from "../../domain/settings/ui-settings.js";
import { loadDiscoverySettings, publishDiscoverySettings } from "../../domain/discovery/discovery.js";
import { listOwnedChannels } from "../../domain/content/channel.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import Screen from "../components/screen.jsx";
import FilePicker from "../components/file-picker.jsx";
import DeleteAccountPanel from "../components/delete-account-panel.jsx";
import { bumpProfileActivity } from "../signals/profile.js";
import IconCopy from "../icons/copy.jsx";
import IconTrash from "../icons/trash.jsx";
import IconEye from "../icons/eye.jsx";
import { t, errorMessage } from "../signals/i18n.js";

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

// Редизайн интерфейса, этап 8 (CONTRACTS.md) — перенесено 1:1 из
// discovery.jsx (файл удалён этим же этапом), тот же паттерн, что
// RelayBlossomSection/SelfHostedSection выше в этом файле. Домен не
// тронут — loadDiscoverySettings/publishDiscoverySettings те же самые.
function VisibilitySection({ ownerPubkey, privKey, dbKey }) {
	const instanceId = useId();
	const [settings, setSettings] = useState(null); // {visible, showChannels, channelIds}
	const [ownedChannels, setOwnedChannels] = useState([]);
	const [error, setError] = useState("");

	useEffect(() => {
		loadDiscoverySettings(ownerPubkey).then(setSettings);
		listOwnedChannels(ownerPubkey, dbKey).then(setOwnedChannels);
	}, [ownerPubkey]);

	async function persist(next) {
		setSettings(next);
		try {
			await ensureConnected(ownerPubkey, privKey, dbKey);
			await publishDiscoverySettings(ownerPubkey, privKey, dbKey, next, publish);
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	function handleVisibleToggle(checked) {
		if (!checked) {
			// Скрыть — сразу, без промежуточного "OK" (симметрично тому, что показ
			// каналов/выбор каналов подтверждаются явно, а спрятаться можно немедленно).
			persist({ ...settings, visible: false });
		} else {
			// Показать — только раскрывает панель настроек ниже, публикация — по "OK".
			setSettings({ ...settings, visible: true });
		}
	}

	function toggleChannelId(channelId) {
		setSettings((prev) => {
			const has = prev.channelIds.includes(channelId);
			return { ...prev, channelIds: has ? prev.channelIds.filter((id) => id !== channelId) : [...prev.channelIds, channelId] };
		});
	}

	if (!settings) return null;

	return (
		<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
			<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
				<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					<IconEye />
					{t("profile.visibilityTitle")}
				</h2>
				<p class="panel__hint">{t("profile.visibilityHint")}</p>
			</div>

			{error && (
				<p role="alert" class="callout callout--bad">
					{error}
				</p>
			)}

			<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
				<span class="set-row__text">{t("discovery.showMeToggle")}</span>
				<input type="checkbox" class="set-row__switch" checked={settings.visible} onChange={(e) => handleVisibleToggle(e.currentTarget.checked)} />
			</label>

			{/* Вложенность больше НЕ передаётся отступом слева (был инлайновый
			    marginInlineStart — margin на компоненте, REGLAMENT.md §3 п.1).
			    Зависимые настройки просто идут следом: включённый верхний
			    переключатель и так их показывает, а выключенный — скрывает. */}
			{settings.visible && (
				<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
					<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
						<span class="set-row__text">{t("discovery.showChannelsToggle")}</span>
						<input
							type="checkbox"
							class="set-row__switch"
							checked={settings.showChannels}
							onChange={(e) => setSettings({ ...settings, showChannels: e.currentTarget.checked })}
						/>
					</label>

					{settings.showChannels && (
						<fieldset
							class="stack"
							style={{ "--gap": "var(--space-s)", borderInlineStart: "none", borderInlineEnd: "none", borderBlockEnd: "none", paddingInline: 0, paddingBlockEnd: 0 }}
						>
							{/* border-block-start/padding-block-start НЕ обнуляем (в отличие от
							    остальных сторон) — это тот самый разделитель, который рисует
							    .set-list > * + * родителя (fieldset — второй ребёнок .set-list
							    выше). Обнулить их инлайном значило бы молча погасить чужой
							    разделитель, найдено при живой проверке пользователем. */}
							<legend class="sect-title">{t("discovery.whichChannelsLegend")}</legend>
							{ownedChannels.length === 0 ? (
								<p class="panel__hint">{t("discovery.noOwnChannels")}</p>
							) : (
								<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
									{ownedChannels.map((c) => (
										<label key={c.id} class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
											<span class="set-row__text">{c.name}</span>
											<input
												id={`${instanceId}-ch-${c.id}`}
												type="checkbox"
												class="set-row__switch"
												checked={settings.channelIds.includes(c.id)}
												onChange={() => toggleChannelId(c.id)}
											/>
										</label>
									))}
								</div>
							)}
						</fieldset>
					)}

					<div class="row" style={{ "--gap": "var(--space-s)" }}>
						<button type="button" class="rigid" onClick={() => persist(settings)}>
							{t("common.save")}
						</button>
					</div>
				</div>
			)}
		</section>
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
			setCopyStatus(t("profile.copiedStatus"));
		} catch {
			setCopyStatus(t("profile.copyFailedStatus"));
		}
		clearTimeout(copyTimerRef.current);
		copyTimerRef.current = setTimeout(() => setCopyStatus(""), 2000);
	}

	// Общий хвост обоих источников аватара (с диска/из хранилища) — публикация
	// ПУБЛИЧНОЙ незашифрованной копии (этап 37) + republish kind 0. Best-effort
	// (та же философия, что handleBioSubmit): локальное превью/кэш НЕ зависит
	// от публикации.
	async function publishAvatarBytes(fileBytes, mimeType) {
		setPublishStatus(t("profile.publishingStatus"));
		try {
			const settings = await loadUiSettings(id, dbKeySig.value);
			const serverUrl = settings.activeBlossomUrl;
			if (!serverUrl) {
				setPublishStatus(t("profile.notPublishedNoBlossom"));
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
			setPublishStatus(result.ok ? "" : t("profile.notPublishedReason", { reason: result.reason || t("profile.relayRejected") }));
		} catch (err) {
			setPublishStatus(t("profile.notPublishedReason", { reason: errorMessage(err) }));
		}
	}

	async function handleAvatarChange(e) {
		const input = e.currentTarget;
		const file = input.files?.[0];
		if (!file) return;
		if (!file.type.startsWith("image/")) {
			setAvatarError(t("profile.selectImageError"));
			input.value = "";
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			setAvatarError(t("profile.fileTooLargeError"));
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
				setAvatarError(t("profile.selectImageError"));
				return;
			}
			if (manifest.size > MAX_AVATAR_BYTES) {
				setAvatarError(t("profile.fileTooLargeError"));
				return;
			}
			const fileKey = await getFileKeyFor(node.blob);
			if (!fileKey) {
				setAvatarError(t("chat.window.fileKeyNotFoundError"));
				return;
			}
			if (!window.confirm(t("profile.avatarPublicConfirm"))) return;
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
			setAvatarError(errorMessage(err));
		}
	}

	async function handleBioSubmit(e) {
		e.preventDefault();
		await updateProfile(id, { bio });
		bumpProfileActivity();
		setSavedBio(bio);
		setBioStatus(t("profile.savedStatus"));
		clearTimeout(statusTimerRef.current);
		statusTimerRef.current = setTimeout(() => setBioStatus(""), 2000);

		// Локальное сохранение НЕ зависит от публикации (профиль в этом экране —
		// keystore-запись, не fold из журнала событий, в отличие от contacts/groups) —
		// публикация в relay отдельный, best-effort шаг: другие пользователи видят
		// никнейм/био через kind 0 (F-CT-04), но офлайн-редактирование остаётся рабочим.
		setPublishStatus(t("profile.publishingStatus"));
		try {
			await ensureConnected(id, privKeySig.value, dbKeySig.value);
			// avatarUrl (этап 38-довесок, найденный реальным использованием баг): БЕЗ
			// него этот republish стирал бы уже опубликованный аватар — kind 0
			// replaceable, отсутствие поля в новой версии = "поля больше нет".
			const event = buildProfileEvent(privKeySig.value, { name: login, about: bio, picture: avatarUrl || undefined });
			const result = await publish(event);
			setPublishStatus(result.ok ? "" : t("profile.notPublishedReason", { reason: result.reason || t("profile.relayRejected") }));
		} catch (err) {
			setPublishStatus(t("profile.notPublishedReason", { reason: errorMessage(err) }));
		}
	}

	if (loading) {
		return (
			<Screen title={t("nav.profile")}>
				<p style={{ color: "var(--muted)" }}>{t("profile.loadingTitle")}</p>
			</Screen>
		);
	}

	const initial = (login || "?").trim().charAt(0).toUpperCase() || "?";
	const bioIsDirty = bio !== savedBio;

	return (
		// Живой фидбек: в шапке было только имя — на экране, где меняют
		// аватар/био/ключ/видимость, непонятно, что именно сейчас открыто
		// (в приложении несколько таких личных экранов). {{имя}}: {{раздел}}
		// — тот же приём просят применить и на "Ключ и восстановление"
		// (security.jsx), и на "Файлы" (files.jsx).
		<Screen title={`${login || t("profile.noNameFallback")}: ${t("sidebarCard.menuProfile")}`}>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
				<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="ident row" style={{ "--gap": "var(--space-m)" }}>
						{/* Фото и две кнопки под ним были парой, делающей одно и то
						    же, но в двух разных формах: "Заменить" — <label>-пилюля
						    (--radius-full), "Из хранилища" — обычная кнопка
						    (--radius). Теперь обе
						    внутри одной накладки на нижней кромке фотографии.
						    .layer — композиционный класс: обе дочки в одной
						    ячейке грида, накладка прижата вниз через .self-end. */}
						<div class="ident__photo">
							<div class="ava layer">
								{/* Приоритет avatar || avatarUrl НЕ менять — см. комментарий
								    этапа 74 в истории файла: корректность обеспечивает
								    инвалидация в hydrateOwnProfile, а не порядок здесь. */}
								{avatar || avatarUrl ? (
									<img src={avatar || avatarUrl} alt="" class="profile-avatar-square" />
								) : (
									<div
										role="img"
										aria-label={t("profile.avatarNotSetAria")}
										class="profile-avatar-square profile-avatar-square-fallback row"
										style={{ "--align": "center", justifyContent: "center" }}
									>
										{initial}
									</div>
								)}
								<div class="ava__actions over self-end bar" style={{ "--gap": "var(--space-3xs)" }}>
									<label for="profile-avatar-input" class="ava__btn bar">
										{t("profile.replaceAvatarLabel")}
									</label>
									<input id="profile-avatar-input" class="visually-hidden" type="file" accept="image/*" onChange={handleAvatarChange} />
									<button type="button" class="ava__btn bar" onClick={() => setAvatarPickerOpen(true)}>
										{t("profile.chooseFromStorageButton")}
									</button>
								</div>
							</div>
							{avatarError && (
								<p role="alert" class="callout callout--bad">
									{avatarError}
								</p>
							)}
						</div>

						{avatarPickerOpen && (
							<FilePicker predicate={(node) => node.kind === "file"} multiple={false} onSelect={handleAvatarFromStorage} onCancel={() => setAvatarPickerOpen(false)} />
						)}

						<form class="ident__body stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleBioSubmit}>
							{/* Живой фидбек: имя пользователя над ключом дублировало заголовок
							    экрана (Screen title теперь тоже содержит имя) — читалось как
							    "имя, потом непонятно что за строка ниже". identifierHeading —
							    уже существовавший, но ни разу не подключённый ключ перевода. */}
							<h2 class="ident__name">{t("profile.identifierHeading")}</h2>

							<div class="keybox row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
								<code>{npubEncode(id)}</code>
								<button type="button" class="icon-btn rigid" onClick={handleCopyNpub} aria-label={t("profile.copyKeyAria")}>
									<IconCopy />
								</button>
							</div>
							{copyStatus && (
								<p role="status" class="panel__hint">
									{copyStatus}
								</p>
							)}
							<p class="panel__hint">{t("profile.identifierHint")}</p>

							<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
								<label for="profile-bio">{t("profile.bioLabel")}</label>
								<textarea id="profile-bio" rows="4" value={bio} onInput={(e) => setBio(e.currentTarget.value)} />
							</div>

							<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
								<button type="submit" class="rigid" disabled={!bioIsDirty}>
									{t("common.save")}
								</button>
								{bioStatus && (
									<span role="status" class="panel__hint">
										{bioStatus}
									</span>
								)}
								{publishStatus && (
									<span role="status" class="panel__hint">
										{publishStatus}
									</span>
								)}
							</div>
						</form>
					</div>
				</section>

				<VisibilitySection ownerPubkey={id} privKey={privKeySig.value} dbKey={dbKeySig.value} />

				{/* Переехало из "Настроек": удаление относится к тому, КТО ты, а
				    не к тому, как ведёт себя приложение. */}
				<section class="panel panel--danger stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
						<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
							<IconTrash />
							{t("settings.dangerZoneTitle")}
						</h2>
					</div>
					<DeleteAccountPanel ownerPubkey={id} login={login} privKey={privKeySig.value} dbKey={dbKeySig.value} />
				</section>
			</div>
		</Screen>
	);
}
