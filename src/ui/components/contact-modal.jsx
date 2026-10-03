import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { npubEncode } from "nostr-tools/nip19";
import { shortPubkey } from "../format.js";
import { currentLocale, t } from "../signals/i18n.js";
import { pushToast } from "../signals/toasts.js";
import { currentUser, privKeySig } from "../signals/auth.js";
import { formatLastSeen } from "../format-last-seen.js";
import { getPeerLastSeenAt, clampLastSeenAt } from "../../domain/messaging/peer-presence.js";
import { getContactSince } from "../signals/contacts.js";
import PermissionEditor from "./permission-editor.jsx";
import IconPhoneCall from "../icons/phone-call.jsx";
import IconChatBubble from "../icons/chat-bubble.jsx";
import IconGear from "../icons/gear.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import IconTrash from "../icons/trash.jsx";
import IconCopy from "../icons/copy.jsx";
import IconCross from "../icons/cross.jsx";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function formatDate(seconds) {
	return new Intl.DateTimeFormat(currentLocale.value, { day: "numeric", month: "long", year: "numeric" }).format(new Date(seconds * 1000));
}

// Карточка контакта: открывается по клику на «аватар+имя+био» в списке контактов. Всё, что
// известно о человеке (большой аватар, био целиком, когда был в сети, с какого времени в
// контактах, профиль, ключ), и все действия: позвонить и открыть чат — сразу под именем,
// права, блокировка и удаление — в подвале. Сама ничего не знает про сеть: действия приходят
// колбэками от экрана «Контакты».
export default function ContactModal({ pubkey, profile, displayName, busy, onClose, onOpenChat, onCall, onBlock, onRemove }) {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dialogRef = useRef(null);
	const [lastSeenAt, setLastSeenAt] = useState(null);
	const [showPermissions, setShowPermissions] = useState(false);
	const contactSince = getContactSince(pubkey);
	const npub = npubEncode(pubkey);

	useEffect(() => {
		let cancelled = false;
		getPeerLastSeenAt(ownerPubkey, pubkey)
			.then((v) => {
				if (!cancelled) setLastSeenAt(v ?? null);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [ownerPubkey, pubkey]);

	// Фокус внутрь диалога при открытии, обратно на вызвавший элемент при закрытии;
	// Tab не выпускает фокус за пределы карточки; Escape закрывает.
	useEffect(() => {
		const opener = document.activeElement;
		dialogRef.current?.focus();
		function onKeyDown(e) {
			if (e.key === "Escape") {
				onClose();
				return;
			}
			if (e.key !== "Tab" || !dialogRef.current) return;
			const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
			if (items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			if (opener instanceof HTMLElement) opener.focus();
		};
	}, [onClose]);

	async function copyKey() {
		try {
			await navigator.clipboard.writeText(npub);
			pushToast({ title: t("account.keyCopied") });
		} catch {
			pushToast({ title: t("account.keyCopyFailed") });
		}
	}

	const clamped = clampLastSeenAt(lastSeenAt, Math.floor(Date.now() / 1000));
	const lastSeen = clamped == null ? "" : formatLastSeen(clamped * 1000, Date.now(), { locale: currentLocale.value });
	const initial = (displayName || "?").trim().charAt(0).toUpperCase();

	return createPortal(
		<div class="modal-backdrop" onClick={onClose}>
			<div
				ref={dialogRef}
				class="modal-card contact-modal"
				role="dialog"
				aria-modal="true"
				aria-label={t("contacts.card.aria", { name: displayName })}
				tabindex={-1}
				onClick={(e) => e.stopPropagation()}
			>
				<button type="button" class="contact-modal__close icon-btn" onClick={onClose} aria-label={t("common.close")}>
					<IconCross aria-hidden="true" />
				</button>

				<div class="contact-modal__body">
					<header class="contact-modal__hero">
						{profile?.picture ? (
							<img src={profile.picture} alt="" class="contact-modal__photo" />
						) : (
							<div class="contact-modal__photo contact-modal__photo--empty" aria-hidden="true">
								{initial}
							</div>
						)}
						<h2 class={"contact-modal__name" + (profile?.name ? "" : " contact-modal__name--npub")}>{displayName}</h2>
						{lastSeen && <p class="contact-modal__status">{t("contacts.card.lastSeen", { when: lastSeen })}</p>}
					</header>

					<div class="contact-modal__primary">
						<button type="button" class="contact-modal__call" onClick={onCall}>
							<IconPhoneCall aria-hidden="true" /> {t("common.call")}
						</button>
						<button type="button" class="contact-modal__chat" onClick={onOpenChat}>
							<IconChatBubble aria-hidden="true" /> {t("contacts.card.openChat")}
						</button>
					</div>

					<section class="contact-modal__section">
						<h3>{t("contacts.card.about")}</h3>
						{profile?.about ? <p class="contact-modal__about">{profile.about}</p> : <p class="contact-modal__empty">{t("contacts.card.noAbout")}</p>}
					</section>

					<section class="contact-modal__section">
						<h3>{t("contacts.card.details")}</h3>
						<dl class="contact-modal__facts">
							{contactSince && (
								<div>
									<dt>{t("contacts.card.contactSince")}</dt>
									<dd>{formatDate(contactSince)}</dd>
								</div>
							)}
							{typeof profile?.createdAt === "number" && (
								<div>
									<dt>{t("contacts.card.profileUpdated")}</dt>
									<dd>{formatDate(profile.createdAt)}</dd>
								</div>
							)}
							<div>
								<dt>{t("contacts.card.key")}</dt>
								<dd class="contact-modal__key">
									<code title={npub}>{shortPubkey(pubkey)}</code>
									<button type="button" class="icon-btn" onClick={copyKey} aria-label={t("shell.copyAddress")} title={t("shell.copyAddress")}>
										<IconCopy aria-hidden="true" />
									</button>
								</dd>
							</div>
						</dl>
					</section>

					{showPermissions && (
						<section class="contact-modal__section">
							<PermissionEditor ownerPubkey={ownerPubkey} privKey={privKey} subject={pubkey} />
						</section>
					)}
				</div>

				<footer class="contact-modal__footer">
					<button type="button" class="btn--ghost" aria-expanded={showPermissions} onClick={() => setShowPermissions((v) => !v)}>
						<IconGear aria-hidden="true" /> {showPermissions ? t("contacts.hidePermissions") : t("contacts.showPermissions")}
					</button>
					<button type="button" class="btn--ghost btn--warn" disabled={busy} onClick={onBlock}>
						<IconLockClosed aria-hidden="true" /> {t("contacts.blockAction")}
					</button>
					<button type="button" class="btn--ghost btn--danger" disabled={busy} onClick={onRemove}>
						<IconTrash aria-hidden="true" /> {t("common.delete")}
					</button>
				</footer>
			</div>
		</div>,
		document.body,
	);
}
