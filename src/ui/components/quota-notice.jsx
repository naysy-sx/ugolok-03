// ТЗ-04, 3.3 — заметка в лотке вложений: место кончается/кончилось/только чтение, со ссылками
// на экран хранилища и на тарифы. Показывается только вместе с лотком (там, где человек
// прикрепляет файлы), не висит на каждом экране.
import { quotaState } from "../signals/quota.js";
import { goTo } from "../signals/place.js";
import { t } from "../signals/i18n.js";
import { quotaLevel } from "../../domain/uploads/quota.js";
import { formatBytes } from "../../domain/uploads/format.js";

export default function QuotaNotice() {
	const state = quotaState.value;
	if (state.status !== "ok") return null;
	const q = state.quota;
	const level = quotaLevel(q);
	if (level !== "warning" && level !== "full" && level !== "readonly") return null;

	const text =
		level === "readonly"
			? t("storage.notice.readonly")
			: level === "full"
				? t("storage.notice.full")
				: t("storage.notice.warning", { free: formatBytes(Math.max(0, q.limit - q.used)), limit: formatBytes(q.limit) });

	return (
		<div class={"callout stack " + (level === "warning" ? "callout--warn" : "callout--bad")} style={{ "--gap": "var(--space-2xs)" }} role="status">
			<span>{text}</span>
			<div class="row" style={{ "--gap": "var(--space-s)", flexWrap: "wrap" }}>
				<button type="button" class="btn--ghost" onClick={() => goTo({ kind: "settings", tab: "storage" })}>
					{t("storage.notice.toStorage")}
				</button>
				<button type="button" class="btn--ghost" onClick={() => goTo({ kind: "plans" })}>
					{t("storage.notice.toPlans")}
				</button>
			</div>
		</div>
	);
}
