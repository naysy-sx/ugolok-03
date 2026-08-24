import { useState, useEffect } from "preact/hooks";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { getOrDownloadMessageAttachment } from "../../domain/files/content-cache.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../attachment-memory-cache.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";

const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Вынесено из channels.jsx (было локальным ChannelAvatarThumb) — тот же
// компонент нужен в панели сайдбара (nav-groups.jsx, разметка по макету,
// этап "область контента" — .ava--sm у каналов там тоже реальная картинка,
// не буква). channel.avatar — ЗАШИФРОВАННЫЙ дескриптор вложения (тот же
// {manifestDigest, fileKey, mime, ...}, что вложения в чате), не готовый
// URL — расшифровка/скачивание те же, что ImageAttachment. small — 28px
// вариант для узкой строки панели вместо дефолтных 44px списка каналов.
export default function ChannelAvatarThumb({ channel, small }) {
	const ownerPubkey = currentUser.value.id;
	const dbKey = dbKeySig.value;
	const [url, setUrl] = useState(() => (channel.avatar ? (getMemoryCachedUrl(channel.avatar.manifestDigest) ?? null) : null));

	useEffect(() => {
		if (!channel.avatar) {
			setUrl(null);
			return;
		}
		const memUrl = getMemoryCachedUrl(channel.avatar.manifestDigest);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadMessageAttachment(ownerPubkey, dbKey, channel.avatar, { serverUrl: BLOSSOM_SERVER_URL })
			.then((bytes) => {
				if (!cancelled) setUrl(putMemoryCachedAttachment(channel.avatar.manifestDigest, bytes, channel.avatar.mime));
			})
			.catch(() => {}); // тихо — остаётся буква-заглушка, не мешаем списку ошибкой
		return () => {
			cancelled = true;
		};
	}, [channel.avatar?.manifestDigest]);

	const sizeClass = small ? "channel-avatar-thumb-sm" : "channel-avatar-thumb";
	if (url) {
		return <img src={url} alt="" class={sizeClass} />;
	}
	return (
		<div class={`${sizeClass} channel-avatar-thumb-fallback row`} style={{ "--align": "center", justifyContent: "center" }} aria-hidden="true">
			{(channel.name || "?").trim().charAt(0).toUpperCase()}
		</div>
	);
}
