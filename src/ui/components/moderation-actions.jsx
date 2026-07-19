import { useState } from "preact/hooks";
import { publish } from "../signals/transport.js";
import { reportContent, ignoreMember } from "../../domain/content/moderation.js";

// Кнопки "Пожаловаться"/"Игнорировать" у комментария/сообщения чата (не у СВОИХ —
// проверка isOwnContent на уровне вызывающего кода, CommentNode/ChannelChat).
// DESIGN.md, этап 33: игнор необратим в этом UI (нет кнопки "снять" ни для кого).
export default function ModerationActions({ viewerPubkey, viewerPrivKey, channelOwnerPubkey, channelId, targetPubkey, contentType, contentId, contentText }) {
	const [status, setStatus] = useState("");

	async function handleReport() {
		const reason = window.prompt("Опишите причину жалобы (необязательно):", "");
		if (reason === null) return; // отмена
		try {
			await reportContent(
				viewerPrivKey,
				channelOwnerPubkey,
				{ channelId, targetPubkey, contentType, contentId, contentText: reason || contentText, reason: "report" },
				publish,
			);
			setStatus("Жалоба отправлена");
		} catch (err) {
			setStatus(err?.message || String(err));
		}
	}

	async function handleIgnore() {
		if (!window.confirm("Игнорировать этого участника в этом канале? Действие необратимо (снять может только владелец).")) return;
		try {
			await ignoreMember(viewerPubkey, viewerPrivKey, channelOwnerPubkey, { channelId, targetPubkey, contentType, contentId, contentText }, publish);
			setStatus("Участник проигнорирован");
		} catch (err) {
			setStatus(err?.message || String(err));
		}
	}

	return (
		<span class="cluster" style={{ "--cluster-gap": "var(--space-3xs)" }}>
			<button type="button" onClick={handleReport}>
				Пожаловаться
			</button>
			<button type="button" onClick={handleIgnore}>
				Игнорировать
			</button>
			{status && <small style={{ color: "var(--muted)" }}>{status}</small>}
		</span>
	);
}
