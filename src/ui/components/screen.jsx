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
// CHANNEL-V2 часть E4 — anchored: .anchored (composition-класс minimal.css,
// overflow-anchor:auto) на .content-wrapper для вкладки чата — прокрутка
// держится низа при подгрузке старых сообщений. false по умолчанию — ни на
// что, кроме чата, не влияет.
export default function Screen({ breadcrumb, title, subtitle, lead, headerExtra, actions, slices, footer, feed, anchored, children }) {
	const titleId = useId();

	return (
		<section class="content-section stack">
			{/* HEADERS (CONTRACTS.md §HEADERS), этап 2 — grid вместо flex-ряда:
			    четыре именованные зоны (back/lead/ident/actions), КАЖДАЯ —
			    прямой ребёнок .section-header (grid-area не работает через
			    обёртку). Раньше вся строка была ОДНИМ .row-контейнером
			    (.header-actions, имя вводило в заблуждение — держал не только
			    действия) — grid берёт на себя то, что раньше решал flex-ряд +
			    margin-inline-start:auto, обёртка-ряд убрана целиком, не
			    переименована. .screen-title рендерится ВСЕГДА (не только при
			    subtitle, как раньше) — иначе заголовок жил бы в двух разных
			    структурах и grid-area пришлось бы описывать дважды. */}
			<header class="section-header rigid">
				{/* Пользователь: не нужна подпись "Назад", и не обычная стрелка,
				    а "уголок" (поворот на 90°) — aria-label несёт весь смысл
				    кнопки, видимого текста больше нет. */}
				{breadcrumb && (
					<button type="button" class="header-back" onClick={breadcrumb.onBack} aria-label={t("screen.backToSectionAria", { label: breadcrumb.label })}>
						<IconCornerBack />
					</button>
				)}
				{lead && <div class="header-lead">{lead}</div>}
				<div class="screen-title">
					<h1 id={titleId} class="screen-title__text">{title}</h1>
					{subtitle && <div class="screen-title__sub">{subtitle}</div>}
				</div>
				{actions && (
					<div class="header-actions" role="group" aria-label={t("screen.sectionActionsAria")}>
						{actions}
					</div>
				)}
				{/* headerExtra — раскрывающийся блок ПОД строкой заголовка (канал
				    §B4), обёртка .header-extra живёт ЗДЕСЬ (не в самом
				    ChannelAbout — тот рендерит .stack, общую композиционную
				    обёртку REGLAMENT.md, вешать grid-специфику на неё испортила
				    бы .stack в любом другом месте проекта). grid-column:1/-1
				    (CSS) — под именованными зонами, во всю ширину, в обеих
				    ширинах контейнера без дублирования правила. */}
				{headerExtra && <div class="header-extra">{headerExtra}</div>}
			</header>

			{/* HEADERS (CONTRACTS.md §HEADERS), этап 1 — слот сужен: ТОЛЬКО
			    навигация по разделам ЭКРАНА (табы channel.jsx). Срезы по
			    типу вложения (были здесь через MediaButtons) переехали
			    внутрь конкретной ленты (chat.jsx/channel.jsx/channel-
			    chat.jsx рендерят их сами, первым элементом children) — в
			    канале на вкладке "Чат" разделы и срез по вложениям нужны
			    ОДНОВРЕМЕННО, один слот их не вмещал. Пусто/undefined ->
			    ничего не рендерится, ноль верстки для остальных экранов. */}
			{slices && <div class="slices-zone">{slices}</div>}

			{/* content-area/content-wrapper — REGLAMENT.md §3 п.3: наложение это
			    .layer (display:grid, grid-area:1/1 на единственного ребёнка), не
			    position:absolute;inset:0. .grow даёт min-block-size:0 — ровно то,
			    ради чего раньше обходили флекс position'ом (см. историю правок). */}
			<div class="content-area grow layer" role={feed ? "feed" : undefined} aria-labelledby={titleId}>
				<div class={`content-wrapper scroller box${anchored ? " anchored" : ""}`} style={{ "--pad": "var(--space-m)" }}>{children}</div>
			</div>

			{footer && <footer class="section-footer rigid box" style={{ "--pad": "var(--space-m)" }}>{footer}</footer>}
		</section>
	);
}
