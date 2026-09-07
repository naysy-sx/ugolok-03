import { traceEnabledSignal } from "../../core/diag/call-trace.js";
import { t } from "../signals/i18n.js";

// TZ-diag-trace.md §1 — "постоянный ненавязчивый признак, что запись идёт":
// без него легко забыть, что флаг включён, и потом гадать, почему файл
// снятой трассировки пуст (флаг выключили ещё вчера) или откуда взялся
// огромный файл (забыли выключить на неделю). Смонтирован рядом с
// CallOverlay/ToastHost (app.jsx) — виден с ЛЮБОГО экрана, не только с
// экрана диагностики.
export default function DiagTraceBadge() {
	if (!traceEnabledSignal.value) return null;
	return (
		<div class="diag-trace-badge" role="status" title={t("diagnostics.trace.recording")}>
			● {t("diagnostics.trace.recording")}
		</div>
	);
}
