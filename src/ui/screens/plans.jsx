// ТЗ-04, 3.5 — экран тарифов (заглушка). Существует, чтобы человеку было куда пойти из «место
// кончилось», и чтобы позже в него встроилась оплата без переделки навигации. Никаких платёжных
// форм: пока место выдаётся вручную по обращению на support@ugolok.tech с указанием npub.
import { useState } from "preact/hooks";
import { npubEncode } from "nostr-tools/nip19";
import Screen from "../components/screen.jsx";
import { currentUser } from "../signals/auth.js";
import { quotaState } from "../signals/quota.js";
import { goTo } from "../signals/place.js";
import { t } from "../signals/i18n.js";
import { formatBytes } from "../../domain/uploads/format.js";
import IconCopy from "../icons/copy.jsx";

const SUPPORT_EMAIL = "support@ugolok.tech";

export default function Plans() {
	const id = currentUser.value?.id;
	const npub = id ? npubEncode(id) : "";
	const [copied, setCopied] = useState("");
	const state = quotaState.value;
	const q = state.status === "ok" ? state.quota : null;

	async function copyNpub() {
		try {
			await navigator.clipboard.writeText(npub);
			setCopied(t("profile.copiedStatus"));
		} catch {
			setCopied(t("profile.copyFailedStatus"));
		}
		setTimeout(() => setCopied(""), 2000);
	}

	const subject = encodeURIComponent(t("plans.mailSubject"));
	const body = encodeURIComponent(t("plans.mailBody", { npub }));

	return (
		<Screen title={t("plans.title")}>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
				<p style={{ margin: 0 }}>{t("plans.intro")}</p>

				{q?.enabled && (
					<p class="callout" style={{ margin: 0 }}>
						{t("plans.yourUsage", { used: formatBytes(q.used), limit: formatBytes(q.limit) })}
					</p>
				)}

				<div class="row" style={{ "--gap": "var(--space-m)", flexWrap: "wrap", alignItems: "stretch" }}>
					<section class="panel stack" style={{ "--gap": "var(--space-2xs)", flex: "1 1 14rem" }}>
						<h2 class="panel__title">{t("plans.free.name")}</h2>
						<p style={{ margin: 0, fontSize: "var(--text-l, 1.25rem)" }}>{t("plans.free.size")}</p>
						<p style={{ margin: 0, color: "var(--muted)" }}>{t("plans.free.desc")}</p>
					</section>
					<section class="panel stack" style={{ "--gap": "var(--space-2xs)", flex: "1 1 14rem" }}>
						<h2 class="panel__title">{t("plans.paid.name")}</h2>
						<p style={{ margin: 0, fontSize: "var(--text-l, 1.25rem)" }}>{t("plans.paid.size")}</p>
						<p style={{ margin: 0 }}>{t("plans.paid.price")}</p>
						<p style={{ margin: 0, color: "var(--muted)" }}>{t("plans.paid.desc")}</p>
					</section>
				</div>

				<section class="panel stack" style={{ "--gap": "var(--space-s)" }}>
					<h2 class="panel__title">{t("plans.how.title")}</h2>
					<p style={{ margin: 0 }}>{t("plans.how.text", { email: SUPPORT_EMAIL })}</p>
					{npub && (
						<div class="keybox row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
							<code>{npub}</code>
							<button type="button" class="icon-btn rigid" onClick={copyNpub} aria-label={t("profile.copyKeyAria")}>
								<IconCopy />
							</button>
						</div>
					)}
					{copied && <small role="status">{copied}</small>}
					<div>
						<a class="btn--ghost" href={`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`}>
							{t("plans.how.write")}
						</a>
					</div>
					<p style={{ margin: 0, color: "var(--muted)" }}>{t("plans.how.note")}</p>
				</section>

				<div>
					<button type="button" class="btn--ghost" onClick={() => goTo({ kind: "settings", tab: "storage" })}>
						{t("plans.back")}
					</button>
				</div>
			</div>
		</Screen>
	);
}
