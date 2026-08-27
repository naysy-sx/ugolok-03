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
// CHANNEL-V2 часть B2 — три необязательных слота добавлены: lead (аватар
// перед заголовком), subtitle (роль/подписчики/дата ПОД заголовком, не
// рядом), headerExtra (раскрывающийся блок ПОД строкой заголовка, целиком
// внутри закреплённой шапки — канал §B4). Все три undefined по умолчанию ->
// разметка ровно та же, что была, остальные экраны не задеты.
export default function Screen({ breadcrumb, title, subtitle, lead, headerExtra, actions, slices, footer, feed, children }) {
	const titleId = useId();

	return (
		<section class="content-section stack">
			<header class="section-header rigid stack box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-m)" }}>
				<div class="header-actions row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
					{/* Пользователь: не нужна подпись "Назад", и не обычная стрелка,
					    а "уголок" (поворот на 90°) — aria-label несёт весь смысл
					    кнопки, видимого текста больше нет. */}
					{breadcrumb && (
						<button type="button" class="back-button row" style={{ "--align": "center", justifyContent: "center" }} onClick={breadcrumb.onBack} aria-label={t("screen.backToSectionAria", { label: breadcrumb.label })}>
							<IconCornerBack />
						</button>
					)}
					{lead}
					{/* Обёртка нужна только чтобы подзаголовок встал ПОД заголовком, а
					    не рядом с ним в общем ряду. .grow — чтобы .action-buttons
					    (margin-inline-start:auto) по-прежнему уезжала вправо. */}
					<div class="screen-title grow stack" style={{ "--gap": "0" }}>
						<h1 id={titleId}>{title}</h1>
						{subtitle}
					</div>
					{actions && (
						<div class="action-buttons row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }} role="group" aria-label={t("screen.sectionActionsAria")}>
							{actions}
						</div>
					)}
				</div>
				{headerExtra}
			</header>

			{/* Этап E медиа-подсистемы — тонкая зона СРАЗУ ПОД шапкой, до
			    content-area (пользователь этой сессии: "у медиа-кнопок должно
			    быть одно и то же положение"). Редизайн интерфейса, этап 3
			    (CONTRACTS.md) — слот переименован mediaButtons -> slices и
			    расширен на 4 экрана (было — chat.jsx/files.jsx, стало — плюс
			    channel.jsx, channel-chat.jsx через него же): это ряд срезов
			    текущего места, не только медиа-кнопки. Пусто/undefined ->
			    ничего не рендерится, ноль верстки для остальных экранов. */}
			{slices && <div class="slices-zone">{slices}</div>}

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
