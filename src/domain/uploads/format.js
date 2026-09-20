// Формат размера для экрана хранилища: доходит до ГБ (formatFileSize в attachment-view.jsx
// заканчивается на МБ). Единицы — из общих переводов attachment.units.*.
import { t } from "../../ui/signals/i18n.js";

export function formatBytes(bytes) {
	const n = Number(bytes) || 0;
	if (n < 1024) return t("attachment.units.bytes", { count: n });
	if (n < 1024 * 1024) return t("attachment.units.kb", { count: (n / 1024).toFixed(1) });
	if (n < 1024 * 1024 * 1024) return t("attachment.units.mb", { count: (n / (1024 * 1024)).toFixed(1) });
	return t("attachment.units.gb", { count: (n / (1024 * 1024 * 1024)).toFixed(2) });
}
