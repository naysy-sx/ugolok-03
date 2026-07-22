import { useId } from "preact/hooks";

// Общий каркас внутреннего экрана (обсуждён с пользователем) — закреплённая
// шапка (крошки + заголовок + действия раздела) и опциональный закреплённый
// подвал вокруг ЕДИНСТВЕННОЙ прокручиваемой зоны. .content-area/.content-wrapper
// (position:relative + position:absolute;inset:0) — устойчивый приём для
// "скроллится ровно то, что осталось от flex-родителя", не полагается на
// капризы flexbox с min-height в разных браузерах.
//
// breadcrumb — необязательный {label, onBack}: показываем только там, где
// есть реальная вложенность (открытый чат/канал), не на плоских экранах —
// плоских "Главная > Раздел" эта не добавляет, дублирует <h1>.
// feed — role="feed" (ARIA-паттерн для динамически подгружаемых лент,
// сообщения/посты/комментарии), НЕ выставляется по умолчанию — формы
// (Настройки/Профиль) им не являются.
export default function Screen({ breadcrumb, title, actions, footer, feed, children }) {
	const titleId = useId();

	return (
		<section class="content-section">
			<header class="section-header">
				{breadcrumb && (
					<nav class="breadcrumbs" aria-label="Навигация по разделам">
						<ol>
							<li>
								<button type="button" onClick={breadcrumb.onBack}>
									{breadcrumb.label}
								</button>
							</li>
							<li aria-current="page">{title}</li>
						</ol>
					</nav>
				)}
				<div class="header-actions">
					<h1 id={titleId}>{title}</h1>
					{actions && (
						<div class="action-buttons" role="group" aria-label="Действия раздела">
							{actions}
						</div>
					)}
				</div>
			</header>

			<div class="content-area" role={feed ? "feed" : undefined} aria-labelledby={titleId}>
				<div class="content-wrapper">{children}</div>
			</div>

			{footer && <footer class="section-footer">{footer}</footer>}
		</section>
	);
}
