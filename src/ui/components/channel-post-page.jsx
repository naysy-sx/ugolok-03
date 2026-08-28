import { useEffect, useState } from "preact/hooks";
import { publish, fetchProfiles, refreshLiveProfileSubscription } from "../signals/transport.js";
import { markChannelAsRead } from "../../domain/content/channel-read-status.js";
import { refreshUnreadChannelsCount } from "../signals/notifications.js";
import { messagingActivity, bumpMessagingActivity } from "../signals/chats.js";
import { ensureProfilesFresh, watchProfiles } from "../signals/contacts.js";
import { place, openChannel } from "../signals/place.js";
import {
	archivePost,
	unpublishPost,
	deletePost,
	setPostDue,
	clearPostDue,
	setPostDone,
	makePostTask,
	unmakePostTask,
	getPost,
} from "../../domain/content/post.js";
import { markDueDateEverSet } from "../../domain/settings/ui-settings.js";
import { getCommentsTree, compareComments } from "../../domain/content/comments.js";
import { collectPostScope, findRefPosition } from "../../domain/media/scope.js";
import { buildPlaylist } from "../../domain/media/playlist.js";
import { refFromAttachment, classOf } from "../../domain/media/media-ref.js";
import { openMedia } from "../signals/media.js";
import MediaButtons from "./media/media-buttons.jsx";
import { kindOf } from "../../domain/content/record-kind.js";
import { toPreviewText } from "../../core/markdown/preview.js";
import {
	listReactionsForPost,
	aggregateReactions,
	setReaction,
} from "../../domain/content/reactions.js";
import Screen from "./screen.jsx";
import ActionsMenu from "./actions-menu.jsx";
import IconTrash from "../icons/trash.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconCheckSquare from "../icons/check-square.jsx";
import IconSquare from "../icons/square.jsx";
import IconCalendar from "../icons/calendar.jsx";
import IconCalendarX from "../icons/calendar-x.jsx";
import IconArchive from "../icons/archive.jsx";
import IconEyeSlash from "../icons/eye-slash.jsx";
import { t, errorMessage } from "../signals/i18n.js";
import MarkdownView from "./markdown-view.jsx";
import { DueChip, formatDateTime } from "./post-card.jsx";
import ReactionRow from "./reaction-row.jsx";
import CommentNode from "./comment-node.jsx";
import ChannelBubbleAttachments from "./channel-bubble-attachments.jsx";
import { CommentComposer, PostEditForm, commentAuthorInfo } from "./channel-shared.jsx";

const ROOT_PAGE = 50;
const FULL_TREE_THRESHOLD = 100;

function countNodes(nodes) {
	return nodes.reduce((sum, node) => sum + 1 + countNodes(node.replies), 0);
}

function flattenAuthors(nodes, acc = []) {
	for (const node of nodes) {
		acc.push(node.authorPubkey);
		flattenAuthors(node.replies, acc);
	}
	return acc;
}

function flattenCreatedAt(nodes, acc = []) {
	for (const node of nodes) {
		acc.push(node.createdAt);
		flattenCreatedAt(node.replies, acc);
	}
	return acc;
}

function treeHasId(nodes, id) {
	for (const node of nodes) {
		if (node.id === id) return true;
		if (treeHasId(node.replies, id)) return true;
	}
	return false;
}

function visibleRootCount(tree, commentId, shown) {
	if (tree.length <= FULL_TREE_THRESHOLD) return tree.length;
	let n = Math.max(ROOT_PAGE, shown);
	if (commentId) {
		while (n < tree.length && !treeHasId(tree.slice(0, n), commentId)) n += ROOT_PAGE;
		if (!treeHasId(tree.slice(0, n), commentId)) return tree.length;
	}
	return Math.min(n, tree.length);
}

// ТЗ редизайн канала A — страница одной записи + дерево комментариев.
export default function ChannelPostPage({
	ownerPubkey,
	privKey,
	dbKey,
	channelId,
	channelRow,
	postId,
	commentId,
	limiter,
}) {
	const [post, setPost] = useState(null);
	const [missing, setMissing] = useState(false);
	const [tree, setTree] = useState([]);
	const [error, setError] = useState("");
	const [postAgg, setPostAgg] = useState({ counts: {}, mine: null });
	const [reactionByTarget, setReactionByTarget] = useState(() => new Map());
	const [shownRoots, setShownRoots] = useState(ROOT_PAGE);
	const [editing, setEditing] = useState(false);

	const isOwner = channelRow.role === "owner";
	const canComment = channelRow.role === "owner" || channelRow.role === "subscriber";
	const canReact = canComment;
	const kind = post ? kindOf(post) : "note";

	async function loadReactions() {
		const rows = await listReactionsForPost(ownerPubkey, dbKey, postId);
		setPostAgg(aggregateReactions(rows.filter((r) => r.targetType === "post"), ownerPubkey));
		const byTarget = new Map();
		const grouped = new Map();
		for (const row of rows) {
			if (row.targetType !== "comment") continue;
			if (!grouped.has(row.targetId)) grouped.set(row.targetId, []);
			grouped.get(row.targetId).push(row);
		}
		for (const [id, list] of grouped) byTarget.set(id, aggregateReactions(list, ownerPubkey));
		setReactionByTarget(byTarget);
	}

	async function refreshComments() {
		const fresh = await getCommentsTree(ownerPubkey, dbKey, postId);
		setTree(fresh);
		// CHANNEL-V2 часть A2 — ensureProfilesFresh вместо ensureProfilesFetched:
		// null (профиль не найден на релее) теперь перезапрашивается с остыванием,
		// не кэшируется навсегда.
		const commentAuthors = [...new Set(flattenAuthors(fresh))];
		if (watchProfiles(commentAuthors)) refreshLiveProfileSubscription(ownerPubkey);
		ensureProfilesFresh(commentAuthors, fetchProfiles).catch(() => {});
		const createdAts = flattenCreatedAt(fresh);
		if (createdAts.length > 0) {
			markChannelAsRead(ownerPubkey, privKey, channelId, Math.max(...createdAts), publish)
				.then(() => refreshUnreadChannelsCount(ownerPubkey, dbKey))
				.catch(() => {});
		}
	}

	async function loadPost() {
		const found = await getPost(ownerPubkey, dbKey, postId);
		if (!found || found.channelId !== channelId) {
			setMissing(true);
			setPost(null);
			return;
		}
		setMissing(false);
		setPost(found);
		// CHANNEL-V2 часть A2/A3 — автор ЗАПИСИ форсируется отдельно (force:true):
		// он важнее авторов дерева комментариев (refreshComments, force:false) —
		// имя автора записи видно первым делом, ждать минуту остывания не должно.
		if (watchProfiles([found.authorPubkey])) refreshLiveProfileSubscription(ownerPubkey);
		ensureProfilesFresh([found.authorPubkey], fetchProfiles, { force: true }).catch(() => {});
		await refreshComments();
		await loadReactions();
	}

	useEffect(() => {
		loadPost().catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey, channelId, postId, messagingActivity.value]);

	const rootsShown = visibleRootCount(tree, commentId, shownRoots);
	const visibleTree = tree.slice(0, rootsShown);

	useEffect(() => {
		if (!commentId) return;
		const el = document.getElementById(`comment-${commentId}`);
		if (!el) return;
		el.scrollIntoView({ block: "center" });
		const target = place.value;
		if (target.kind === "channel" && target.id === channelId && target.commentId) {
			place.value = { ...target, commentId: undefined };
		}
	}, [commentId, visibleTree]);

	async function runAction(fn) {
		try {
			await fn();
			const found = await getPost(ownerPubkey, dbKey, postId);
			setPost(found);
			bumpMessagingActivity();
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	function runDueAction(fn) {
		return runAction(fn);
	}

	function handleSetDue() {
		const input = window.prompt(t("postCard.setDuePrompt"));
		if (input === null) return;
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
		const dueAt = match ? Math.floor(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() / 1000) : NaN;
		if (!match || Number.isNaN(dueAt)) {
			window.alert(t("postCard.setDueInvalid"));
			return;
		}
		runDueAction(async () => {
			await setPostDue(ownerPubkey, post.id, dueAt);
			await markDueDateEverSet(ownerPubkey, privKey, dbKey, publish);
		});
	}

	function openAttachment(attachment, sourceMeta) {
		if (!post) return;
		const refs = collectPostScope({ post, commentsTree: tree, compareSiblings: compareComments });
		const target = refFromAttachment(attachment, sourceMeta);
		const position = findRefPosition(refs, target.digest, target.sourceMeta);
		if (position === -1) return;
		openMedia({ refs, position });
	}

	async function handleOpenMediaClass(cls) {
		try {
			const commentsTree = await getCommentsTree(ownerPubkey, dbKey, postId);
			const refs = collectPostScope({ post, commentsTree, compareSiblings: compareComments });
			const playlist = buildPlaylist(refs);
			const position = playlist.idx[cls]?.[0];
			if (position === undefined) return;
			openMedia({ refs, position });
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	// Живой фидбег: считало true/false — фильтр в шапке всегда показывал "1"
	// независимо от реального числа изображений/файлов записи.
	function slicesCounts() {
		if (!post) return { audio: 0, video: 0, image: 0, other: 0 };
		const refs = collectPostScope({ post, commentsTree: tree, compareSiblings: compareComments });
		const present = { audio: 0, video: 0, image: 0, other: 0 };
		for (const ref of refs) {
			const c = classOf(ref.mime);
			if (c in present) present[c]++;
		}
		return present;
	}

	async function handleToggleReaction(targetType, targetId, reactionPostId, emoji) {
		if (!limiter.tryAction("react")) {
			setError(t("common.rateLimitError"));
			return;
		}
		try {
			await setReaction(ownerPubkey, privKey, dbKey, channelId, targetType, targetId, reactionPostId, emoji, publish);
			bumpMessagingActivity();
			await loadReactions();
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	const breadcrumb = { label: channelRow.name || t("channels.card.untitled"), onBack: () => openChannel(channelId) };

	if (missing) {
		return (
			<Screen breadcrumb={breadcrumb} title={t("channel.postPageTitle")}>
				<p role="alert" style={{ color: "var(--bad)" }}>
					{t("channel.postUnavailable")}
				</p>
				<button type="button" onClick={() => openChannel(channelId)}>
					{t("channel.backToFeed")}
				</button>
			</Screen>
		);
	}

	if (!post) {
		return (
			<Screen breadcrumb={breadcrumb} title={t("channel.postPageTitle")}>
				<p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>
			</Screen>
		);
	}

	const hasChips = post.dueAt !== null || (post.tags && post.tags.length > 0);
	// CHANNEL-V2 часть D1 — автора на странице записи не было вообще, хотя
	// .post__ava/.post__ava-fallback/.post__author лежали мёртвым CSS с
	// этапа 69 (см. комментарий post-card.jsx:57). Действия переезжают в ту
	// же строку, справа — раньше ActionsMenu висел ниже текста за распоркой
	// <span class="grow" />, что читалось как случайность.
	const author = commentAuthorInfo(post.authorPubkey);

	return (
		<Screen
			breadcrumb={breadcrumb}
			// Живой фидбег: заголовок статьи уже есть у поста — логичнее показать
			// его прямо в шапке экрана, чем везде писать общую "Запись". Дублирующий
			// <h2 class="post-page__title"> в теле статьи убран (см. ниже).
			title={kind === "article" && post.title ? post.title : t("channel.postPageTitle")}
			slices={<MediaButtons counts={slicesCounts()} onOpen={handleOpenMediaClass} />}
		>
			<article class="post-page stack" style={{ "--gap": "var(--space-s)" }}>
				{error && (
					<p role="alert" style={{ color: "var(--bad)" }}>
						{error}
					</p>
				)}
				<div class="post-byline bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
					{author.avatar ? (
						<img src={author.avatar} alt="" class="post__ava rigid" />
					) : (
						<div aria-hidden="true" class="post__ava post__ava-fallback rigid row" style={{ "--align": "center", justifyContent: "center" }}>
							{(author.name || "?").trim().charAt(0).toUpperCase()}
						</div>
					)}
					<div class="stack grow" style={{ "--gap": "0" }}>
						<span class={author.isNpub ? "post__author post__author--npub" : "post__author"}>{author.name}</span>
						<span class="post-page__meta">
							{t(`recordKind.${kind}`)} · {formatDateTime(post.createdAt)}
							{post.status === "archived" ? ` · ${t("postCard.archivedLabel")}` : ""}
						</span>
					</div>
					{isOwner && (
						<ActionsMenu label={t("postCard.actionsAria", { excerpt: toPreviewText(post.text, { profile: "rich", maxLength: 40 }) || t("postCard.noTextFallback") })}>
							{!editing && (
								<button type="button" onClick={() => setEditing(true)}>
									<IconPencil /> {t("postCard.editButton")}
								</button>
							)}
							{kind === "task" ? (
								<button type="button" onClick={() => runDueAction(() => unmakePostTask(ownerPubkey, post.id))}>
									<IconSquare /> {t("postCard.unmakeTaskButton")}
								</button>
							) : (
								<button type="button" onClick={() => runDueAction(() => makePostTask(ownerPubkey, post.id))}>
									<IconCheckSquare /> {t("postCard.makeTaskButton")}
								</button>
							)}
							{post.dueAt === null ? (
								<button type="button" onClick={handleSetDue}>
									<IconCalendar /> {t("postCard.setDueButton")}
								</button>
							) : (
								<button type="button" onClick={() => runDueAction(() => clearPostDue(ownerPubkey, post.id))}>
									<IconCalendarX /> {t("postCard.clearDueButton")}
								</button>
							)}
							{post.status === "published" && (
								<button type="button" onClick={() => runAction(() => archivePost(ownerPubkey, privKey, dbKey, post.id, publish))}>
									<IconArchive /> {t("postCard.archiveButton")}
								</button>
							)}
							{post.status === "published" && (
								<button type="button" onClick={() => runAction(() => unpublishPost(ownerPubkey, privKey, dbKey, post.id, publish))}>
									<IconEyeSlash /> {t("postCard.unpublishButton")}
								</button>
							)}
							<button type="button" class="danger" onClick={() => {
								if (window.confirm(t("channel.deletePostConfirm"))) {
									runAction(async () => {
										await deletePost(ownerPubkey, privKey, post.id, publish);
										openChannel(channelId);
									});
								}
							}}>
								<IconTrash /> {t("common.delete")}
							</button>
						</ActionsMenu>
					)}
				</div>
				{editing ? (
					<PostEditForm
						post={post}
						ownerPubkey={ownerPubkey}
						privKey={privKey}
						dbKey={dbKey}
						limiter={limiter}
						onSaved={() => {
							setEditing(false);
							runAction(async () => {});
						}}
						onCancel={() => setEditing(false)}
					/>
				) : (
					<>
				<ChannelBubbleAttachments attachments={post.attachments} onOpen={(a) => openAttachment(a, { postId: post.id })} />
				{kind === "task" ? (
					<label class="task">
						<input type="checkbox" checked={post.done === true} onChange={(e) => runDueAction(() => setPostDone(ownerPubkey, post.id, e.currentTarget.checked))} />
						<span class="post-page__body">
							<MarkdownView source={post.text} profile="rich" />
						</span>
					</label>
				) : post.text ? (
					<div class="post-page__body">
						<MarkdownView source={post.text} profile="rich" />
					</div>
				) : null}
				{kind === "link" && (
					<div class="link">
						<div class="link__fav" aria-hidden="true">
							{(post.linkUrl || "?").replace(/^https?:\/\//, "").charAt(0).toUpperCase()}
						</div>
						<div class="link__meta">
							<div class="link__t">{post.title || post.linkUrl}</div>
							<div class="link__d">{post.linkUrl}</div>
						</div>
					</div>
				)}
					</>
				)}
				{hasChips && (
					<div class="rec-chips">
						<DueChip post={post} />
						{(post.tags ?? []).map((tag) => (
							<span class="rec-chip rec-chip--tag" key={tag}>
								{tag}
							</span>
						))}
					</div>
				)}
				<ReactionRow
					counts={postAgg.counts}
					mine={postAgg.mine}
					canReact={canReact}
					onToggle={(emoji) => handleToggleReaction("post", post.id, post.id, emoji)}
				/>

				<section class="cmt-section">
					<div class="cmt-head">
						<h2>{t("channel.commentsTitle")}</h2>
						<span class="ch-stats">{countNodes(tree)}</span>
					</div>
					{tree.length === 0 ? (
						<p style={{ color: "var(--muted)" }}>{t("channel.noComments")}</p>
					) : (
						<ul class="cmt-list">
							{visibleTree.map((c) => (
								<CommentNode
									key={c.id}
									comment={c}
									canComment={canComment}
									canReact={canReact}
									ownerPubkey={ownerPubkey}
									privKey={privKey}
									dbKey={dbKey}
									channelId={channelId}
									channelOwnerPubkey={channelRow.creatorPubkey}
									postId={post.id}
									postAuthorPubkey={post.authorPubkey}
									limiter={limiter}
									onChanged={refreshComments}
									highlightCommentId={commentId}
									onOpenAttachment={openAttachment}
									reactionByTarget={reactionByTarget}
									onToggleReaction={handleToggleReaction}
								/>
							))}
						</ul>
					)}
					{rootsShown < tree.length && (
						<button type="button" class="load-more btn--ghost" onClick={() => setShownRoots((n) => n + ROOT_PAGE)}>
							{t("channel.moreComments")}
						</button>
					)}
					{/* Живой фидбег: композитор был НАД деревом комментариев — теперь
					    под уже существующими, как и обычно устроены обсуждения. */}
					{canComment ? (
						<CommentComposer
							ownerPubkey={ownerPubkey}
							privKey={privKey}
							dbKey={dbKey}
							channelId={channelId}
							postId={post.id}
							parentId={post.id}
							limiter={limiter}
							onSubmitted={refreshComments}
						/>
					) : (
						<p style={{ color: "var(--muted)" }}>{t("channel.readOnlyNotice")}</p>
					)}
				</section>
			</article>
		</Screen>
	);
}
