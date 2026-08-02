import { useState } from "preact/hooks";
import Screen from "../components/screen.jsx";
import MarkdownView from "../components/markdown-view.jsx";
import oProekte from "../../content/help/o-proekte.md?raw";
import stek from "../../content/help/stek.md?raw";
import privatnost from "../../content/help/privatnost.md?raw";
import kontaktyIKanaly from "../../content/help/kontakty-i-kanaly.md?raw";
import iskhodnyjKod from "../../content/help/iskhodnyj-kod.md?raw";

// Рубрикатор — чистые данные (порядок = порядок в жизненном цикле знакомства
// с проектом: сначала "что это", потом "как пользоваться", потом детали для
// продвинутых). Темы бандлятся в сборку как обычные JS-строки (Vite's `?raw`,
// без внешних библиотек markdown — см. CONTRACTS.md, "Раздел Справка").
const TOPICS = [
	{ id: "o-proekte", title: "О проекте", source: oProekte },
	{ id: "kontakty-i-kanaly", title: "Контакты и каналы", source: kontaktyIKanaly },
	{ id: "privatnost", title: "Приватность", source: privatnost },
	{ id: "stek", title: "Технологии", source: stek },
	{ id: "iskhodnyj-kod", title: "Исходный код", source: iskhodnyjKod },
];

export default function Help() {
	const [activeTopicId, setActiveTopicId] = useState(TOPICS[0].id);
	const activeTopic = TOPICS.find((t) => t.id === activeTopicId) ?? TOPICS[0];

	return (
		<Screen title="Справка">
			<div class="help-layout">
				<nav class="help-rubricator" aria-label="Темы справки">
					<ul role="list">
						{TOPICS.map((topic) => (
							<li key={topic.id}>
								<button
									type="button"
									class={topic.id === activeTopicId ? "help-topic-btn help-topic-btn--active" : "help-topic-btn"}
									onClick={() => setActiveTopicId(topic.id)}
									aria-current={topic.id === activeTopicId ? "true" : undefined}
								>
									{topic.title}
								</button>
							</li>
						))}
					</ul>
				</nav>
				<div class="help-content">
					<MarkdownView source={activeTopic.source} />
				</div>
			</div>
		</Screen>
	);
}
