// ТЗ-04, 3.4 — полоса заполнения: занято из потолка. Три состояния (норма / предупреждение /
// исчерпано) + «только чтение» и «без ограничений». Пороги — в клиенте (domain/uploads/quota.js).
import { t } from "../signals/i18n.js";
import { formatBytes } from "../../domain/uploads/format.js";
import { quotaLevel } from "../../domain/uploads/quota.js";

export default function QuotaBar({ quota, onGetMore }) {
	const level = quotaLevel(quota);
	if (!quota) return null;

	if (level === "unlimited") {
		return <p style={{ margin: 0, color: "var(--muted)" }}>{t("storage.quota.unlimited")}</p>;
	}

	const pct = Math.min(100, Math.round((quota.used / quota.limit) * 100));
	const free = Math.max(0, quota.limit - quota.used);
	return (
		<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
			<div
				class="storage-bar"
				data-level={level}
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={quota.limit}
				aria-valuenow={Math.min(quota.used, quota.limit)}
				aria-label={t("storage.quota.barAria")}
			>
				<div class="storage-bar__fill" style={{ width: `${pct}%` }} />
			</div>
			<p style={{ margin: 0 }}>{t("storage.quota.usedOfLimit", { used: formatBytes(quota.used), limit: formatBytes(quota.limit) })}</p>
			{level === "warning" && <p class="callout callout--warn" style={{ margin: 0 }}>{t("storage.quota.warning", { free: formatBytes(free) })}</p>}
			{level === "full" && <p class="callout callout--bad" style={{ margin: 0 }}>{t("storage.quota.full")}</p>}
			{level === "readonly" && <p class="callout callout--bad" style={{ margin: 0 }}>{t("storage.quota.readonly")}</p>}
			{(level === "warning" || level === "full" || level === "readonly") && onGetMore && (
				<div>
					<button type="button" class="btn--ghost" onClick={onGetMore}>
						{t("storage.quota.getMore")}
					</button>
				</div>
			)}
		</div>
	);
}
