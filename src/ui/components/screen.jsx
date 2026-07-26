import { useId } from "preact/hooks";
import IconCornerBack from "../icons/corner-back.jsx";

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
		<section class="content-section">
			<header class="section-header">
				<div class="header-actions">
					{/* Пользователь: не нужна подпись "Назад", и не обычная стрелка,
					    а "уголок" (поворот на 90°) — aria-label несёт весь смысл
					    кнопки, видимого текста больше нет. */}
					{breadcrumb && (
						<button type="button" class="back-button" onClick={breadcrumb.onBack} aria-label={`Назад к разделу «${breadcrumb.label}»`}>
							<IconCornerBack />
						</button>
					)}
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
