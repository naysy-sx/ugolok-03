import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, refreshChannelContentSubscription } from "../signals/transport.js";
import { groups, refreshGroups } from "../signals/contacts.js";
import { messagingActivity } from "../signals/chats.js";
import {
	createChannel,
	listOwnedChannels,
	listSubscribedChannels,
	listAvailableChannels,
	subscribeToChannelAction,
} from "../../domain/content/channel.js";
import { validateAttachment } from "../../domain/files/attachment-validation.js";
import { uploadMessageAttachment } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { place, openChannel } from "../signals/place.js";
import ChannelDetail from "./channel.jsx";
import ChannelAvatarThumb from "../components/channel-avatar-thumb.jsx";
import Screen from "../components/screen.jsx";
import IconPlus from "../icons/plus.jsx";
import { t, currentLocale, errorMessage } from "../signals/i18n.js";

const NAME_MAX_LENGTH = 100; // ТЗ пользователя
const DESCRIPTION_MAX_LENGTH = 500;
const RULES_MAX_LENGTH = 1000;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function formatUpdatedDate(unixSeconds) {
	if (typeof unixSeconds !== "number") return null;
	return new Date(unixSeconds * 1000).toLocaleDateString(currentLocale.value, { day: "2-digit", month: "long", year: "numeric" });
}

function ChannelCard({ channel, showSubscribe, onSubscribe, onOpen, busy }) {
	const updated = formatUpdatedDate(channel.updatedAt);
	return (
		<li class="channel-card-item row" style={{ "--gap": "var(--space-s)", "--align": "center", justifyContent: "space-between" }}>
			<button type="button" onClick={() => onOpen(channel.id)} class="channel-card-link row grow" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<ChannelAvatarThumb channel={channel} />
				<span class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<strong>{channel.name || t("channels.card.untitled")}</strong>
					{channel.description && <small>{channel.description}</small>}
					{updated && <small class="channel-card-updated">{t("channels.card.updated", { date: updated })}</small>}
				</span>
			</button>
			{showSubscribe && (
				<button type="button" disabled={busy} onClick={() => onSubscribe(channel.id)}>
					{t("channels.card.subscribeButton")}
				</button>
			)}
		</li>
	);
}

function ChannelList({ channels, emptyText, showSubscribe, onSubscribe, onOpen, busy }) {
	if (channels.length === 0) {
		return <p style={{ color: "var(--muted)" }}>{emptyText}</p>;
	}
	return (
		<ul role="list" class="channel-list stack" style={{ "--gap": "var(--space-2xs)" }}>
			{channels.map((channel) => (
				<ChannelCard key={channel.id} channel={channel} showSubscribe={showSubscribe} onSubscribe={onSubscribe} onOpen={onOpen} busy={busy} />
			))}
		</ul>
	);
}

function CreateChannelForm({ ownerPubkey, privKey, dbKey, onCreated, onCancel }) {
	const instanceId = useId();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [rules, setRules] = useState("");
	const [avatarFile, setAvatarFile] = useState(null);
	const [avatarError, setAvatarError] = useState("");
	const [allowChatAttachments, setAllowChatAttachments] = useState(true);
	const [selectedGroupIds, setSelectedGroupIds] = useState(() => new Set());
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		refreshGroups(ownerPubkey, dbKey).catch(() => {});
	}, [ownerPubkey]);

	function handleAvatarSelected(e) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = "";
		if (!file) return;
		setAvatarFile(file);
		try {
			validateAttachment({ mime: file.type, size: file.size });
			setAvatarError("");
		} catch (err) {
			setAvatarError(errorMessage(err));
		}
	}

	function toggleGroup(groupId) {
		setSelectedGroupIds((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			return next;
		});
	}

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || name.length === 0) return;
		if (avatarFile && avatarError) return;
		setBusy(true);
		setError("");
		try {
			let avatarDescriptor;
			if (avatarFile) {
				const bytes = new Uint8Array(await avatarFile.arrayBuffer());
				avatarDescriptor = await uploadMessageAttachment(BLOSSOM_SERVER_URL, bytes, { mime: avatarFile.type, name: avatarFile.name }, privKey);
			}
			await createChannel(
				ownerPubkey,
				privKey,
				dbKey,
				{ name, description, rules, avatarDescriptor, allowChatAttachments },
				[...selectedGroupIds],
				publish,
			);
			await refreshChannelContentSubscription(ownerPubkey, dbKey);
			onCreated();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form class="stack box" onSubmit={handleSubmit} style={{ "--gap": "var(--space-s)", "--pad": "var(--space-m)", border: "var(--border-width) solid var(--border)", borderRadius: "var(--radius)" }}>
			<h2>{t("channels.create.title")}</h2>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for={`${instanceId}-name`}>{t("channels.create.nameLabel")}</label>
				<input
					id={`${instanceId}-name`}
					type="text"
					value={name}
					maxLength={NAME_MAX_LENGTH}
					onInput={(e) => setName(e.currentTarget.value)}
					required
				/>
			</div>

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for={`${instanceId}-description`}>{t("channels.create.descriptionLabel")}</label>
				<textarea
					id={`${instanceId}-description`}
					value={description}
					maxLength={DESCRIPTION_MAX_LENGTH}
					onInput={(e) => setDescription(e.currentTarget.value)}
					rows={3}
				/>
			</div>

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for={`${instanceId}-rules`}>{t("channels.create.rulesLabel")}</label>
				<textarea
					id={`${instanceId}-rules`}
					value={rules}
					maxLength={RULES_MAX_LENGTH}
					onInput={(e) => setRules(e.currentTarget.value)}
					rows={4}
				/>
			</div>

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for={`${instanceId}-avatar`}>{t("channels.create.avatarLabel")}</label>
				<input id={`${instanceId}-avatar`} type="file" accept="image/*" onChange={handleAvatarSelected} />
				{avatarFile && <small style={{ color: avatarError ? "var(--bad)" : "var(--muted)" }}>{avatarError || avatarFile.name}</small>}
			</div>

			<div class="row" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
				<input
					id={`${instanceId}-allow-chat-attachments`}
					type="checkbox"
					checked={allowChatAttachments}
					onChange={(e) => setAllowChatAttachments(e.currentTarget.checked)}
				/>
				<label for={`${instanceId}-allow-chat-attachments`}>{t("channels.create.allowChatAttachmentsLabel")}</label>
			</div>

			{/* Не в панели/боксе — своей рамки+радиуса+отступа не заглушаем
			    (fieldset в minimal.css уже token-based), тот же вид, что у
			    unlock.jsx/permission-editor.jsx. Найдено живой проверкой:
			    обнулённый border/padding без внешней рамки-опоры выглядит
			    голым. */}
			<fieldset class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<legend>{t("channels.create.visibilityLegend")}</legend>
				<p style={{ color: "var(--muted)" }}>
					{t("channels.create.visibilityHint")}
				</p>
				{groups.value.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{t("channels.create.noGroups")}</p>
				) : (
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{groups.value.map((g) => (
							<li key={g.id}>
								<span class="row" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
									<input
										id={`${instanceId}-group-${g.id}`}
										type="checkbox"
										checked={selectedGroupIds.has(g.id)}
										onChange={() => toggleGroup(g.id)}
									/>
									<label for={`${instanceId}-group-${g.id}`}>
										{t("channels.create.groupWithCount", { name: g.name, count: g.memberPubkeys.length })}
									</label>
								</span>
							</li>
						))}
					</ul>
				)}
			</fieldset>

			<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<button type="submit" disabled={busy || name.length === 0}>
					{busy ? t("channels.create.submitting") : t("common.create")}
				</button>
				<button type="button" onClick={onCancel} disabled={busy}>
					{t("common.cancel")}
				</button>
			</div>
		</form>
	);
}

function ChannelsList() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	const [owned, setOwned] = useState([]);
	const [subscribed, setSubscribed] = useState([]);
	const [available, setAvailable] = useState([]);
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		ensureConnected(ownerPubkey, privKey, dbKey).catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey]);

	async function refreshLists() {
		setOwned(await listOwnedChannels(ownerPubkey, dbKey));
		setSubscribed(await listSubscribedChannels(ownerPubkey, dbKey));
		setAvailable(await listAvailableChannels(ownerPubkey, dbKey));
	}

	// messagingActivity — тот же диспетчерский сигнал, что чат/контакты (этап 27,
	// находка 2): transport.js бампает его на новый VIEW-грант/метаданные/allowlist.
	useEffect(() => {
		refreshLists().catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey, messagingActivity.value]);

	async function handleSubscribe(channelId) {
		setBusy(true);
		setError("");
		try {
			await subscribeToChannelAction(ownerPubkey, privKey, channelId, publish);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Screen
			title={t("nav.channels")}
			actions={
				!showCreateForm && (
					<button type="button" onClick={() => setShowCreateForm(true)}>
						<IconPlus /> {t("channels.createChannelButton")}
					</button>
				)
			}
		>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			{showCreateForm && (
				<CreateChannelForm
					ownerPubkey={ownerPubkey}
					privKey={privKey}
					dbKey={dbKey}
					onCreated={() => {
						setShowCreateForm(false);
						refreshLists();
					}}
					onCancel={() => setShowCreateForm(false)}
				/>
			)}

			{/* Пользователь: "Мои каналы"/"Подписки" — не табы, а прямо блоки в
			    контенте; "Доступные" — в дополнительном aside справа, чтобы всегда
			    было видно. */}
			<div class="channels-layout">
				<div class="channels-main stack" style={{ "--gap": "var(--space-l)" }}>
					<section class="channels-block">
						<h2>{t("channels.list.myChannelsTitle", { count: owned.length })}</h2>
						<ChannelList channels={owned} emptyText={t("channels.list.myChannelsEmpty")} onOpen={openChannel} />
					</section>
					<section class="channels-block">
						<h2>{t("channels.list.subscriptionsTitle", { count: subscribed.length })}</h2>
						<ChannelList channels={subscribed} emptyText={t("channels.list.subscriptionsEmpty")} onOpen={openChannel} />
					</section>
				</div>
				<aside class="channels-aside" aria-label={t("channels.list.availableAriaLabel")}>
					<h2>{t("channels.list.availableTitle", { count: available.length })}</h2>
					<ChannelList
						channels={available}
						emptyText={t("channels.list.availableEmpty")}
						showSubscribe
						onSubscribe={handleSubscribe}
						onOpen={openChannel}
						busy={busy}
					/>
				</aside>
			</div>
		</Screen>
	);
}

export default function Channels() {
	if (place.value.kind === "channel" && place.value.id) {
		return <ChannelDetail ownerPubkey={currentUser.value.id} privKey={privKeySig.value} dbKey={dbKeySig.value} channelId={place.value.id} />;
	}
	return <ChannelsList />;
}
