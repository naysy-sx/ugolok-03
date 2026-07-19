import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig } from "../signals/auth.js";
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
import { validateAttachment } from "../../domain/attachments/validation.js";
import { uploadAttachment } from "../../domain/attachments/upload.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { activeChannelId, openChannel } from "../signals/channel-nav.js";
import ChannelDetail from "./channel.jsx";

const NAME_MAX_LENGTH = 100; // ТЗ пользователя
const DESCRIPTION_MAX_LENGTH = 500;
const RULES_MAX_LENGTH = 1000;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function ChannelCard({ channel, showSubscribe, onSubscribe, onOpen, busy }) {
	return (
		<li style={{ paddingBlock: "var(--space-s)", borderBlockEnd: "var(--border-width) solid var(--border)" }}>
			<div class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
				<button
					type="button"
					onClick={() => onOpen(channel.id)}
					class="cluster"
					style={{ alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit" }}
				>
					{channel.avatar ? (
						<span aria-hidden="true" style={{ fontSize: "1.5rem" }}>
							🖼️
						</span>
					) : (
						<div
							aria-hidden="true"
							style={{
								width: "2rem",
								height: "2rem",
								borderRadius: "50%",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								background: "var(--surface)",
								border: "var(--border-width) solid var(--border)",
							}}
						>
							{(channel.name || "?").trim().charAt(0).toUpperCase()}
						</div>
					)}
					<span class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<strong>{channel.name || "(без названия)"}</strong>
						{channel.description && <small style={{ color: "var(--muted)" }}>{channel.description}</small>}
					</span>
				</button>
				{showSubscribe && (
					<button type="button" disabled={busy} onClick={() => onSubscribe(channel.id)}>
						Подписаться
					</button>
				)}
			</div>
		</li>
	);
}

function ChannelList({ channels, emptyText, showSubscribe, onSubscribe, onOpen, busy }) {
	if (channels.length === 0) {
		return <p style={{ color: "var(--muted)" }}>{emptyText}</p>;
	}
	return (
		<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
			{channels.map((channel) => (
				<ChannelCard key={channel.id} channel={channel} showSubscribe={showSubscribe} onSubscribe={onSubscribe} onOpen={onOpen} busy={busy} />
			))}
		</ul>
	);
}

function CreateChannelForm({ ownerPubkey, privKey, onCreated, onCancel }) {
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
		refreshGroups(ownerPubkey).catch(() => {});
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
			setAvatarError(err?.message || String(err));
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
				avatarDescriptor = await uploadAttachment(BLOSSOM_SERVER_URL, bytes, { mime: avatarFile.type, name: avatarFile.name }, privKey);
			}
			await createChannel(
				ownerPubkey,
				privKey,
				{ name, description, rules, avatarDescriptor, allowChatAttachments },
				[...selectedGroupIds],
				publish,
			);
			await refreshChannelContentSubscription(ownerPubkey);
			onCreated();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form class="flow" onSubmit={handleSubmit} style={{ "--flow-space": "var(--space-s)", border: "var(--border-width) solid var(--border)", padding: "var(--space-m)", borderRadius: "var(--radius)" }}>
			<h2>Создать канал</h2>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<label for={`${instanceId}-name`}>Название канала</label>
				<input
					id={`${instanceId}-name`}
					type="text"
					value={name}
					maxLength={NAME_MAX_LENGTH}
					onInput={(e) => setName(e.currentTarget.value)}
					required
				/>
			</div>

			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<label for={`${instanceId}-description`}>Описание</label>
				<textarea
					id={`${instanceId}-description`}
					value={description}
					maxLength={DESCRIPTION_MAX_LENGTH}
					onInput={(e) => setDescription(e.currentTarget.value)}
					rows={3}
				/>
			</div>

			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<label for={`${instanceId}-rules`}>Правила канала</label>
				<textarea
					id={`${instanceId}-rules`}
					value={rules}
					maxLength={RULES_MAX_LENGTH}
					onInput={(e) => setRules(e.currentTarget.value)}
					rows={4}
				/>
			</div>

			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<label for={`${instanceId}-avatar`}>Аватар канала</label>
				<input id={`${instanceId}-avatar`} type="file" accept="image/*" onChange={handleAvatarSelected} />
				{avatarFile && <small style={{ color: avatarError ? "var(--bad, oklch(0.58 0.21 25))" : "var(--muted)" }}>{avatarError || avatarFile.name}</small>}
			</div>

			<div class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
				<input
					id={`${instanceId}-allow-chat-attachments`}
					type="checkbox"
					checked={allowChatAttachments}
					onChange={(e) => setAllowChatAttachments(e.currentTarget.checked)}
				/>
				<label for={`${instanceId}-allow-chat-attachments`}>Разрешить вложения в общем чате канала</label>
			</div>

			<fieldset class="flow" style={{ "--flow-space": "var(--space-3xs)", border: "none", padding: 0 }}>
				<legend>Видимость по группам контактов</legend>
				<p style={{ color: "var(--muted)" }}>
					Канал увидят участники отмеченных групп. Если не отметить ни одной — канал останется только у вас (заметочник).
				</p>
				{groups.value.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>Групп контактов пока нет.</p>
				) : (
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{groups.value.map((g) => (
							<li key={g.id}>
								<span class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
									<input
										id={`${instanceId}-group-${g.id}`}
										type="checkbox"
										checked={selectedGroupIds.has(g.id)}
										onChange={() => toggleGroup(g.id)}
									/>
									<label for={`${instanceId}-group-${g.id}`}>
										{g.name} ({g.memberPubkeys.length})
									</label>
								</span>
							</li>
						))}
					</ul>
				)}
			</fieldset>

			<div class="cluster">
				<button type="submit" disabled={busy || name.length === 0}>
					{busy ? "Создание…" : "Создать"}
				</button>
				<button type="button" onClick={onCancel} disabled={busy}>
					Отмена
				</button>
			</div>
		</form>
	);
}

function ChannelsList() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;

	const [tab, setTab] = useState("owned");
	const [owned, setOwned] = useState([]);
	const [subscribed, setSubscribed] = useState([]);
	const [available, setAvailable] = useState([]);
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		ensureConnected(ownerPubkey, privKey).catch((e) => setError(e?.message || String(e)));
	}, [ownerPubkey]);

	async function refreshLists() {
		setOwned(await listOwnedChannels(ownerPubkey));
		setSubscribed(await listSubscribedChannels(ownerPubkey));
		setAvailable(await listAvailableChannels(ownerPubkey));
	}

	// messagingActivity — тот же диспетчерский сигнал, что чат/контакты (этап 27,
	// находка 2): transport.js бампает его на новый VIEW-грант/метаданные/allowlist.
	useEffect(() => {
		refreshLists().catch((e) => setError(e?.message || String(e)));
	}, [ownerPubkey, messagingActivity.value]);

	async function handleSubscribe(channelId) {
		setBusy(true);
		setError("");
		try {
			await subscribeToChannelAction(ownerPubkey, privKey, channelId, publish);
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<main class="flow" style={{ padding: "var(--space-m)", "--container": "56rem" }}>
			<header class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<p class="eyebrow">Уголок</p>
				<h1>Каналы</h1>
			</header>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<div class="cluster" role="tablist" aria-label="Каналы">
				<button type="button" role="tab" aria-selected={tab === "owned"} onClick={() => setTab("owned")}>
					Мои каналы ({owned.length})
				</button>
				<button type="button" role="tab" aria-selected={tab === "subscribed"} onClick={() => setTab("subscribed")}>
					Подписки ({subscribed.length})
				</button>
				<button type="button" role="tab" aria-selected={tab === "available"} onClick={() => setTab("available")}>
					Доступные ({available.length})
				</button>
			</div>

			{tab === "owned" && (
				<section class="flow" role="tabpanel" style={{ "--flow-space": "var(--space-s)" }}>
					{!showCreateForm && (
						<button type="button" onClick={() => setShowCreateForm(true)}>
							Создать канал
						</button>
					)}
					{showCreateForm && (
						<CreateChannelForm
							ownerPubkey={ownerPubkey}
							privKey={privKey}
							onCreated={() => {
								setShowCreateForm(false);
								refreshLists();
							}}
							onCancel={() => setShowCreateForm(false)}
						/>
					)}
					<ChannelList channels={owned} emptyText="У вас пока нет каналов." onOpen={openChannel} />
				</section>
			)}

			{tab === "subscribed" && (
				<section role="tabpanel">
					<ChannelList channels={subscribed} emptyText="Вы пока ни на что не подписаны." onOpen={openChannel} />
				</section>
			)}

			{tab === "available" && (
				<section role="tabpanel">
					<ChannelList
						channels={available}
						emptyText="Нет доступных каналов."
						showSubscribe
						onSubscribe={handleSubscribe}
						onOpen={openChannel}
						busy={busy}
					/>
				</section>
			)}
		</main>
	);
}

export default function Channels() {
	if (activeChannelId.value) {
		return <ChannelDetail ownerPubkey={currentUser.value.id} privKey={privKeySig.value} channelId={activeChannelId.value} />;
	}
	return <ChannelsList />;
}
