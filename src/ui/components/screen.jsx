import { useId } from "preact/hooks";
import IconCornerBack from "../icons/corner-back.jsx";
import { t } from "../signals/i18n.js";

// Общий каркас внутреннего экрана (обсуждён с пользователем) — закреплённая
// шапка (кнопка "назад" + заголовок + действия раздела) и опциональный
// закреплённый подвал вокруг ЕДИНСТВЕННОЙ прокручиваемой зоны.
// .content-area/.content-wrapper (position:relative + position:absolute;inset:0)
// — устойчивый приём для "скроллится ровно то, что осталось от flex-родителя",
// не полагается на капризы flexbox с min-height в разных браузерах.
//
// breadcrumb — необязательный {label, onBack}: кнопка "Назад" перед
// заголовком, показываем только там, где есть реальная вложенность (открытый
// чат/канал), не на плоских экранах. Пользователь: "перед самим заголовком
// сделать большую красивую стрелку 'Назад'" — раньше это была текстовая
// хлебная крошка НАД заголовком, теперь сама кнопка стоит прямо перед <h1>.
// feed — role="feed" (ARIA-паттерн для динамически подгружаемых лент,
// сообщения/посты/комментарии), НЕ выставляется по умолчанию — формы
// (Настройки/Профиль) им не являются.
export default function Screen({ breadcrumb, title, actions, footer, feed, children }) {
	const titleId = useId();

	return (
		<section class="content-section stack">
			<header class="section-header rigid stack box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-m)" }}>
				<div class="header-actions row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
					{/* Пользователь: не нужна подпись "Назад", и не обычная стрелка,
					    а "уголок" (поворот на 90°) — aria-label несёт весь смысл
					    кнопки, видимого текста больше нет. */}
					{breadcrumb && (
						<button type="button" class="back-button row" style={{ alignItems: "center", justifyContent: "center" }} onClick={breadcrumb.onBack} aria-label={t("screen.backToSectionAria", { label: breadcrumb.label })}>
							<IconCornerBack />
						</button>
					)}
					<h1 id={titleId}>{title}</h1>
					{actions && (
						<div class="action-buttons row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} role="group" aria-label={t("screen.sectionActionsAria")}>
							{actions}
						</div>
					)}
				</div>
			</header>

			{/* content-area/content-wrapper — REGLAMENT.md §3 п.3: наложение это
			    .layer (display:grid, grid-area:1/1 на единственного ребёнка), не
			    position:absolute;inset:0. .grow даёт min-block-size:0 — ровно то,
			    ради чего раньше обходили флекс position'ом (см. историю правок). */}
			<div class="content-area grow layer" role={feed ? "feed" : undefined} aria-labelledby={titleId}>
				<div class="content-wrapper scroller box" style={{ "--pad": "var(--space-m)" }}>{children}</div>
			</div>

			{footer && <footer class="section-footer rigid box" style={{ "--pad": "var(--space-m)" }}>{footer}</footer>}
		</section>
	);
}
