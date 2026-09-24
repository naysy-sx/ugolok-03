import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { bumpMessagingActivity } from "../signals/chats.js";
import { loadPinned, pinChannel, unpinChannel, pinPerson, unpinPerson } from "../../domain/contacts/pinned.js";
import IconStar from "../icons/star.jsx";
import IconStarFill from "../icons/star-fill.jsx";
import { t } from "../signals/i18n.js";

// «В избранное» — звёздочка на строке чата и на карточке канала. Раньше пометка
// ставилась только из списков в боковом меню; меню теперь короткое (по макету),
// поэтому переключатель живёт там, где человек видит сам чат/канал. Данные и
// события те же (domain/contacts/pinned.js, kind 30066) — здесь только кнопка.
const pinnedState = signal({ channels: [], people: [] });
let loadedFor = null;

async function reload(ownerPubkey, dbKey) {
	pinnedState.value = await loadPinned(ownerPubkey, dbKey);
}

export default function FavStar({ kind, id, name }) {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	useEffect(() => {
		if (loadedFor === ownerPubkey) return;
		loadedFor = ownerPubkey;
		reload(ownerPubkey, dbKey).catch(() => {
			loadedFor = null;
		});
	}, [ownerPubkey]);

	const list = kind === "channel" ? pinnedState.value.channels : pinnedState.value.people;
	const isPinned = list.includes(id);
	const Star = isPinned ? IconStarFill : IconStar;

	async function toggle(e) {
		e.stopPropagation();
		const action = kind === "channel" ? (isPinned ? unpinChannel : pinChannel) : isPinned ? unpinPerson : pinPerson;
		await action(ownerPubkey, privKey, dbKey, id, publish);
		await reload(ownerPubkey, dbKey);
		bumpMessagingActivity(); // боковое меню перечитывает «Избранное» по этому сигналу
	}

	return (
		<button type="button" class="fav-toggle" onClick={toggle} aria-pressed={isPinned} aria-label={t(isPinned ? "account.favRemove" : "account.favAdd", { name })}>
			<Star />
		</button>
	);
}
