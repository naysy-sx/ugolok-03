import { useEffect, useState } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { dueRecords, refreshDueRecords, refreshDueBadge } from "../signals/today.js";
import { groupDueRecords } from "../../domain/content/due-schedule.js";
import { setPostDue, clearPostDue, setPostDone, makePostTask, unmakePostTask, archivePost, unpublishPost, deletePost } from "../../domain/content/post.js";
import { openChannel, setChannelPostTarget } from "../signals/channel-nav.js";
import Screen from "../components/screen.jsx";
import PostCard from "../components/post-card.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// Редизайн интерфейса, этап 4 (CONTRACTS.md) — "мягкий вход органайзера".
// Переиспользует ТУ ЖЕ PostCard, что лента канала (REDESIGN-SPEC.md) — её
// контракт (этап 2) не меняется, новых пропов не добавлено. isOwner всегда
// true: dueAt/done в этом проекте ставятся ТОЛЬКО через isOwner-гейт в самой
// PostCard (post-card.jsx:139, ActionsMenu), поэтому любая запись, дошедшая
// сюда через listDueRecords(текущий аккаунт), обязана быть его собственной.
function goToRecord(record) {
	openChannel(record.channelId);
	setChannelPostTarget({ postId: record.id });
}

// Клик по остальной площади карточки уводит в канал (REDESIGN-SPEC.md,
// этап 4); клик по чекбоксу/меню/кнопкам внутри — их собственное поведение,
// навигация не должна его перехватывать.
function handleCardClick(e, record) {
	if (e.target.closest("button, input, a, summary")) return;
	goToRecord(record);
}

export default function Today({ onBack }) {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;
	const [error, setError] = useState("");

	useEffect(() => {
		refreshDueRecords(ownerPubkey, dbKey);
	}, [ownerPubkey]);

	async function runAction(fn) {
		try {
			await fn();
			await refreshDueRecords(ownerPubkey, dbKey);
			await refreshDueBadge(ownerPubkey, dbKey);
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	// Комментарии/медиа-срез конкретного поста нуждаются в контексте его
	// канала (rate-limiter, дерево комментариев, per-channel media-индекс) —
	// экран "Сегодня" охватывает записи из РАЗНЫХ каналов сразу, поэтому не
	// строит их здесь заново: клик по "Комментарии" уводит в канал, как и
	// клик по остальной карточке (goToRecord).
	const groups = groupDueRecords(dueRecords.value);

	function renderGroup(labelKey, records) {
		if (records.length === 0) return null;
		return (
			<section class="stack" style={{ "--gap": "var(--space-s)" }}>
				<h2>{t(labelKey)}</h2>
				{records.map((record) => (
					<div key={record.id} class="today-record" onClick={(e) => handleCardClick(e, record)}>
						<PostCard
							post={record}
							isOwner={true}
							commentCount={0}
							mediaCounts={null}
							onOpenComments={() => goToRecord(record)}
							onOpenMediaClass={() => goToRecord(record)}
							onOpenAttachment={() => goToRecord(record)}
							onToggleDone={(done) => runAction(() => setPostDone(ownerPubkey, record.id, done))}
							onMakeTask={() => runAction(() => makePostTask(ownerPubkey, record.id))}
							onUnmakeTask={() => runAction(() => unmakePostTask(ownerPubkey, record.id))}
							onSetDue={() => {
								const input = window.prompt(t("postCard.setDuePrompt"));
								if (input === null) return;
								const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
								const dueAt = match ? Math.floor(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() / 1000) : NaN;
								if (!match || Number.isNaN(dueAt)) {
									window.alert(t("postCard.setDueInvalid"));
									return;
								}
								runAction(() => setPostDue(ownerPubkey, record.id, dueAt));
							}}
							onClearDue={() => runAction(() => clearPostDue(ownerPubkey, record.id))}
							onArchive={() => runAction(() => archivePost(ownerPubkey, privKey, dbKey, record.id, publish))}
							onUnpublish={() => runAction(() => unpublishPost(ownerPubkey, privKey, dbKey, record.id, publish))}
							onDelete={() => {
								if (window.confirm(t("channel.deletePostConfirm"))) runAction(() => deletePost(ownerPubkey, privKey, record.id, publish));
							}}
						/>
					</div>
				))}
			</section>
		);
	}

	return (
		<Screen breadcrumb={{ label: t("nav.journal"), onBack }} title={t("today.title")}>
			{error && (
				<p role="alert" class="box" style={{ "--pad": "var(--space-m)", color: "var(--bad)" }}>
					{error}
				</p>
			)}
			{groups.overdue.length + groups.today.length + groups.later.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>{t("today.empty")}</p>
			) : (
				<div class="stack" style={{ "--gap": "var(--space-l)" }}>
					{renderGroup("today.overdueGroup", groups.overdue)}
					{renderGroup("today.todayGroup", groups.today)}
					{renderGroup("today.laterGroup", groups.later)}
				</div>
			)}
		</Screen>
	);
}
