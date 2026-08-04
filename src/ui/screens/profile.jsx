import { useState, useEffect, useRef } from "preact/hooks";
import { npubEncode } from "nostr-tools/nip19";
import { getProfile, updateProfile } from "../../core/crypto/keystore.js";
import { buildProfileEvent, uploadAvatarBlob } from "../../domain/identity/profile.js";
import { getManifest, getRange } from "../../domain/files/content.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, reconnectWithNewSettings } from "../signals/transport.js";
import { projected, getFileKeyFor } from "../signals/files.js";
import {
	loadUiSettings,
	addRelayUrl,
	removeRelayUrl,
	setRelayRole,
	addBlossomUrl,
	removeBlossomUrl,
	setActiveBlossomUrl,
	pairSelfHostedServer,
	unpairSelfHostedServer,
	SelfHostedFingerprintMismatchError,
} from "../../domain/settings/ui-settings.js";
import { decodePairingCode, fetchAgentStatus } from "../../domain/selfhost/pairing.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import Screen from "../components/screen.jsx";
import FilePicker from "../components/file-picker.jsx";
import { bumpProfileActivity } from "../signals/profile.js";
import IconCopy from "../icons/copy.jsx";
import IconTrash from "../icons/trash.jsx";
import IconPlus from "../icons/plus.jsx";
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
			setError(errorMessage(err));
		}
	}

	async function runAction(fn) {
		setError("");
		try {
			await fn();
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<section class="stack" style={{ "--gap": "var(--space-2xs)" }} aria-labelledby={`srv-${title}`}>
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
						{url === activeUrl && <span class="badge-on">{t("profile.server.activeLabel")}</span>}
						{url !== activeUrl && (
							<button type="button" class="btn--ghost" disabled={busy} onClick={() => runAction(() => onSetActive(url))}>
								{t("profile.server.makeActiveButton")}
							</button>
						)}
						<button
							type="button"
							class="icon-btn"
							disabled={busy}
							onClick={() => runAction(() => onRemove(url))}
							aria-label={t("profile.server.deleteAria", { url })}
						>
							<IconTrash />
						</button>
					</li>
				))}
				{urls.length === 0 && (
					<li style={{ color: "var(--muted)" }} class="srv__item">
						{t("profile.server.emptyList")}
					</li>
				)}
			</ul>
			<form class="srv__add" onSubmit={handleAdd}>
				<label class="visually-hidden" for={`${title}-new-url`}>
					{t("profile.server.addLabel")}
				</label>
				<input
					id={`${title}-new-url`}
					type="text"
					placeholder={urlPlaceholder}
					value={newUrl}
					onInput={(e) => setNewUrl(e.currentTarget.value)}
				/>
				<button type="submit" class="btn--ghost" disabled={busy || !newUrl.trim()}>
					<IconPlus /> {t("common.add")}
				</button>
			</form>
		</section>
	);
}

// Этап 58 — мультирелейный транспорт: relayUrls теперь {url,read,write}[],
// "один активный" не имеет смысла при одновременной работе с несколькими
// (CONTRACTS.md/DESIGN.md, этап 58). Blossom остаётся single-active
// (ServerListEditor выше, без изменений) — это отдельный, более поздний
// вопрос (этап 62/63), не путать.
function RelayListEditor({ urls, onAdd, onRemove, onSetRole, busy }) {
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
			setError(errorMessage(err));
		}
	}

	async function runAction(fn) {
		setError("");
		try {
			await fn();
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<section class="stack" style={{ "--gap": "var(--space-2xs)" }} aria-labelledby="srv-relay">
			<h2 id="srv-relay" class="sect-title">
				{t("profile.relay.heading")}
			</h2>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			<ul role="list" class="srv__list">
				{urls.map((r) => (
					<li key={r.url} class="srv__item">
						<span class="srv__url">{r.url}</span>
						<label>
							<input
								type="checkbox"
								checked={r.read}
								disabled={busy}
								onChange={(e) => runAction(() => onSetRole(r.url, { read: e.currentTarget.checked, write: r.write }))}
							/>
							{t("profile.relay.readLabel")}
						</label>
						<label>
							<input
								type="checkbox"
								checked={r.write}
								disabled={busy}
								onChange={(e) => runAction(() => onSetRole(r.url, { read: r.read, write: e.currentTarget.checked }))}
							/>
							{t("profile.relay.writeLabel")}
						</label>
						<button
							type="button"
							class="icon-btn"
							disabled={busy}
							onClick={() => runAction(() => onRemove(r.url))}
							aria-label={t("profile.server.deleteAria", { url: r.url })}
						>
							<IconTrash />
						</button>
					</li>
				))}
				{urls.length === 0 && (
					<li style={{ color: "var(--muted)" }} class="srv__item">
						{t("profile.server.emptyList")}
					</li>
				)}
			</ul>
			<form class="srv__add" onSubmit={handleAdd}>
				<label class="visually-hidden" for="relay-new-url">
					{t("profile.server.addLabel")}
				</label>
				<input id="relay-new-url" type="text" placeholder="wss://relay.example.com" value={newUrl} onInput={(e) => setNewUrl(e.currentTarget.value)} />
				<button type="submit" class="btn--ghost" disabled={busy || !newUrl.trim()}>
					<IconPlus /> {t("common.add")}
				</button>
			</form>
		</section>
	);
}

// Этап 63, И3 — экран сопряжения с self-hosted инстансом (agent/install.sh).
// Вставка пейринг-кода ДЕКОДИРУЕТСЯ и ПРОВЕРЯЕТСЯ живым запросом /status
// ДО сохранения (pairSelfHostedServer) — не сохраняем то, до чего не смогли
// достучаться (частая причина отказа — пользователь ещё не открыл https://
// host:port/ в отдельной вкладке и не принял самоподписанный сертификат,
// см. CONTRACTS.md "Этап 63, И3": браузер не даёт JS проверить TLS-
// сертификат напрямую, единственный реальный путь — штатный browser-flow).
function SelfHostedSection({ ownerPubkey, privKey, dbKey }) {
	const [settings, setSettings] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [code, setCode] = useState("");
	const [status, setStatus] = useState(null);

	async function refresh() {
		setSettings(await loadUiSettings(ownerPubkey, dbKey));
	}

	useEffect(() => {
		refresh().catch(() => {});
	}, [ownerPubkey]);

	async function attemptPair(force) {
		setError("");
		setBusy(true);
		try {
			const pairing = decodePairingCode(code.trim());
			const agentStatus = await fetchAgentStatus(pairing);
			await pairSelfHostedServer(ownerPubkey, privKey, dbKey, pairing, publish, { force });
			setStatus(agentStatus);
			setCode("");
			await refresh();
		} catch (err) {
			if (err instanceof SelfHostedFingerprintMismatchError) {
				const confirmed = window.confirm(t("profile.selfHosted.fingerprintMismatchConfirm"));
				if (confirmed) {
					setBusy(false);
					await attemptPair(true);
					return;
				}
				setError(t("profile.selfHosted.pairingCancelled"));
			} else {
				setError(errorMessage(err));
			}
		} finally {
			setBusy(false);
		}
	}

	async function handlePairSubmit(e) {
		e.preventDefault();
		if (!code.trim() || busy) return;
		await attemptPair(false);
	}

	async function handleUnpair() {
		if (!window.confirm(t("profile.selfHosted.unpairConfirm"))) return;
		setBusy(true);
		setError("");
		try {
			await unpairSelfHostedServer(ownerPubkey, privKey, dbKey, publish);
			setStatus(null);
			await refresh();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleRefreshStatus() {
		if (!settings?.selfHostedServer) return;
		setBusy(true);
		setError("");
		try {
			setStatus(await fetchAgentStatus(settings.selfHostedServer));
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	if (!settings) return null;
	const paired = settings.selfHostedServer;

	return (
		<section class="stack" style={{ "--gap": "var(--space-2xs)" }} aria-labelledby="selfhost-heading">
			<h2 id="selfhost-heading" class="sect-title">
				{t("profile.selfHosted.heading")}
			</h2>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			{paired ? (
				<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<p>
						{t("profile.selfHosted.connectedLabel")}{" "}
						<strong>
							{paired.host}:{paired.port}
						</strong>
					</p>
					<p style={{ color: "var(--muted)", fontSize: "0.85em" }}>{t("profile.selfHosted.fingerprintLabel", { fingerprint: paired.fingerprint })}</p>
					{status && (
						<ul role="list">
							{(status.services || []).map((s) => (
								<li key={s.Service}>
									{s.Service}: {s.State}
								</li>
							))}
						</ul>
					)}
					<div style={{ display: "flex", gap: "var(--space-2xs)" }}>
						<button type="button" class="btn--ghost" disabled={busy} onClick={handleRefreshStatus}>
							{t("profile.selfHosted.refreshStatusButton")}
						</button>
						<button type="button" class="btn--ghost" disabled={busy} onClick={handleUnpair}>
							{t("profile.selfHosted.disconnectButton")}
						</button>
					</div>
				</div>
			) : (
				<form class="stack" style={{ "--gap": "var(--space-2xs)" }} onSubmit={handlePairSubmit}>
					<p style={{ color: "var(--muted)" }}>
						{t("profile.selfHosted.instructionsBeforeCode")} <code>install.sh</code> {t("profile.selfHosted.instructionsAfterCode")}
					</p>
					<label class="visually-hidden" for="pairing-code">
						{t("profile.selfHosted.pairingCodeLabel")}
					</label>
					<textarea
						id="pairing-code"
						rows={3}
						placeholder={t("profile.selfHosted.pairingCodePlaceholder")}
						value={code}
						onInput={(e) => setCode(e.currentTarget.value)}
					/>
					<button type="submit" class="btn--ghost" disabled={busy || !code.trim()}>
						{t("profile.selfHosted.connectButton")}
					</button>
				</form>
			)}
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
		<div class="stack" style={{ "--gap": "var(--space-m)" }}>
			<RelayListEditor
				urls={settings.relayUrls}
				busy={busy}
				onAdd={(url) => withBusy(() => addRelayUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onRemove={(url) => withBusy(() => removeRelayUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onSetRole={(url, role) =>
					withBusy(async () => {
						await setRelayRole(ownerPubkey, privKey, dbKey, url, role, publish);
						await reconnectWithNewSettings(ownerPubkey, privKey, dbKeySig.value);
					})
				}
			/>
			<ServerListEditor
				title={t("profile.blossomServersTitle")}
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
		<Screen title={login || t("profile.noNameFallback")}>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
			<section class="stack" style={{ "--gap": "var(--space-m)" }} aria-labelledby="profile-npub-heading">
				<h2 id="profile-npub-heading" class="sect-title">
					{t("profile.identifierHeading")}
				</h2>
				<div class="keybox">
					<code>{npubEncode(id)}</code>
					<button type="button" class="icon-btn" onClick={handleCopyNpub} aria-label={t("profile.copyKeyAria")}>
						<IconCopy />
					</button>
				</div>
				{copyStatus && (
					<p role="status" style={{ color: "var(--muted)" }}>
						{copyStatus}
					</p>
				)}
				<p class="hint">{t("profile.identifierHint")}</p>
			</section>

			{/* Пользователь: "перекомпоновать блоки с аватаром и о себе — две
			    колонки: в первой маленькой квадратный аватар и кнопка 'Заменить'
			    внизу, во второй большой — блок 'О себе'". aria-label вместо
			    видимого <h2> "Аватар" — левая колонка теперь читается сама по
			    себе (фото + кнопка под ним), а "О себе" остаётся единственным
			    видимым заголовком блока. */}
			<div class="profile-photo-layout">
				<div class="profile-photo-col" aria-label={t("profile.avatarColumnAria")}>
					{/* avatarUrl (публичный Blossom URL) — фолбэк, когда локального
					    data-url кэша ещё нет: НОВОЕ устройство подтягивает bio/avatarUrl
					    из своего же kind 0 при bootstrap (hydrateOwnProfile, profile.js),
					    но avatar (сам файл как data-url) — только через локальную загрузку;
					    без фолбэка аватар выглядел бы пустым до первой замены на новом
					    устройстве, хотя публичная копия уже известна. */}
					{avatar || avatarUrl ? (
						<img src={avatar || avatarUrl} alt="" class="profile-avatar-square" />
					) : (
						<div role="img" aria-label={t("profile.avatarNotSetAria")} class="profile-avatar-square profile-avatar-square-fallback">
							{initial}
						</div>
					)}
					<label for="profile-avatar-input" class="profile-avatar-replace-btn">
						{t("profile.replaceAvatarLabel")}
					</label>
					<input
						id="profile-avatar-input"
						class="visually-hidden"
						type="file"
						accept="image/*"
						onChange={handleAvatarChange}
					/>
					<button type="button" class="btn--ghost" onClick={() => setAvatarPickerOpen(true)}>
						{t("profile.chooseFromStorageButton")}
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

				<form class="stack profile-bio-col" style={{ "--gap": "var(--space-m)" }} onSubmit={handleBioSubmit}>
					<fieldset class="stack" style={{ "--gap": "var(--space-m)" }}>
						<legend class="sect-title">{t("profile.aboutMeLegend")}</legend>
						<label for="profile-bio">{t("profile.bioLabel")}</label>
						<textarea
							id="profile-bio"
							rows="4"
							value={bio}
							onInput={(e) => setBio(e.currentTarget.value)}
						/>
					</fieldset>
					<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
						<button type="submit" disabled={!bioIsDirty}>
							{t("common.save")}
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

			<section class="stack" style={{ "--gap": "var(--space-m)" }} aria-labelledby="profile-files-heading">
				<h2 id="profile-files-heading" class="sect-title">
					{t("nav.files")}
				</h2>
				<div class="files-empty">{t("profile.filesComingSoon")}</div>
			</section>

			<RelayBlossomSection ownerPubkey={id} privKey={privKeySig.value} dbKey={dbKeySig.value} />
			<SelfHostedSection ownerPubkey={id} privKey={privKeySig.value} dbKey={dbKeySig.value} />
			</div>
		</Screen>
	);
}
