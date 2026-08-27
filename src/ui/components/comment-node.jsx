import { useState } from "preact/hooks";
import { t } from "../signals/i18n.js";
import ActionsMenu from "./actions-menu.jsx";
import ModerationActions from "./moderation-actions.jsx";
import MarkdownView from "./markdown-view.jsx";
import ReactionRow from "./reaction-row.jsx";
import ChannelBubbleAttachments from "./channel-bubble-attachments.jsx";
import { commentAuthorInfo, CommentComposer } from "./channel-shared.jsx";
import { formatDateTime } from "./post-card.jsx";

// ТЗ редизайн канала A — дерево без <details>, «ответить» тихое, вложения как в чате.
export default function CommentNode({
	comment,
	canComment,
	canReact,
	ownerPubkey,
	privKey,
	dbKey,
	channelId,
	channelOwnerPubkey,
	postId,
	postAuthorPubkey,
	limiter,
	onChanged,
	highlightCommentId,
	onOpenAttachment,
	reactionByTarget,
	onToggleReaction,
}) {
	const [replying, setReplying] = useState(false);
	const isOwnComment = comment.authorPubkey === ownerPubkey;
	const isTarget = comment.id === highlightCommentId;
	const isOP = comment.authorPubkey === postAuthorPubkey;
	const author = commentAuthorInfo(comment.authorPubkey);
	const agg = reactionByTarget?.get(comment.id) || { counts: {}, mine: null };

	return (
		<li id={`comment-${comment.id}`} class={`cmt${isTarget ? " is-target-comment" : ""}${replying ? " is-replying" : ""}`}>
			<article class="cmt__box">
				{author.avatar ? (
					<img src={author.avatar} alt="" class="cmt__ava" />
				) : (
					<div aria-hidden="true" class="cmt__ava cmt__ava-fallback">
						{(author.name || "?").trim().charAt(0).toUpperCase()}
					</div>
				)}
				<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
					<header class="cmt__head row" style={{ "--gap": "var(--space-2xs)", "--align": "baseline" }}>
						<span class="cmt__name">{author.name}</span>
						{isOP && <span class="cmt__op">{t("channel.comment.authorBadge")}</span>}
						<time class="cmt__time">{formatDateTime(comment.createdAt)}</time>
						{canComment && (
							<button type="button" class="cmt__reply" onClick={() => setReplying((v) => !v)}>
								{t("channel.comment.replyButton")}
							</button>
						)}
						{!isOwnComment && (
							<ActionsMenu label={t("channel.comment.moreActionsAria", { name: author.name })}>
								<ModerationActions
									viewerPubkey={ownerPubkey}
									viewerPrivKey={privKey}
									channelOwnerPubkey={channelOwnerPubkey}
									channelId={channelId}
									targetPubkey={comment.authorPubkey}
									contentType="comment"
									contentId={comment.id}
									contentText={comment.text}
								/>
							</ActionsMenu>
						)}
					</header>
					<div class="cmt__text">
						<MarkdownView source={comment.text} profile="lite" />
					</div>
					{(comment.attachments?.length > 0) && (
						<div class="cmt__media">
							<ChannelBubbleAttachments attachments={comment.attachments} onOpen={(a) => onOpenAttachment?.(a, { commentId: comment.id })} />
						</div>
					)}
					<ReactionRow
						counts={agg.counts}
						mine={agg.mine}
						canReact={canReact}
						compact
						onToggle={(emoji) => onToggleReaction("comment", comment.id, postId, emoji)}
					/>
					{replying && (
						<div class="cmt-reply-form">
							<CommentComposer
								ownerPubkey={ownerPubkey}
								privKey={privKey}
								dbKey={dbKey}
								channelId={channelId}
								postId={postId}
								parentId={comment.id}
								limiter={limiter}
								autoFocus
								onSubmitted={() => {
									setReplying(false);
									onChanged();
								}}
								onCancel={() => setReplying(false)}
							/>
						</div>
					)}
				</div>
			</article>
			{comment.replies.length > 0 && (
				<ul class="cmt-list cmt-list--replies">
					{comment.replies.map((reply) => (
						<CommentNode
							key={reply.id}
							comment={reply}
							canComment={canComment}
							canReact={canReact}
							ownerPubkey={ownerPubkey}
							privKey={privKey}
							dbKey={dbKey}
							channelId={channelId}
							channelOwnerPubkey={channelOwnerPubkey}
							postId={postId}
							postAuthorPubkey={postAuthorPubkey}
							limiter={limiter}
							onChanged={onChanged}
							highlightCommentId={highlightCommentId}
							onOpenAttachment={onOpenAttachment}
							reactionByTarget={reactionByTarget}
							onToggleReaction={onToggleReaction}
						/>
					))}
				</ul>
			)}
		</li>
	);
}
