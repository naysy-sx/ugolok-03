import { useState } from "preact/hooks";
import MarkdownView from "./markdown-view.jsx";
import { t, currentLocale } from "../signals/i18n.js";

// Этап 64 — перевод содержимого Справки: src/content/help/{locale}/{topic-id}.md,
// 12 языков × 5 тем = 60 файлов, все бандлятся статически (?raw, тот же приём,
// что раньше) — единый html-файл всё равно включает всё, лениво грузить
// markdown по языку нечем в single-file сборке (см. CONTRACTS.md).
import oProekteRu from "../../content/help/ru/o-proekte.md?raw";
import kontaktyIKanalyRu from "../../content/help/ru/kontakty-i-kanaly.md?raw";
import privatnostRu from "../../content/help/ru/privatnost.md?raw";
import stekRu from "../../content/help/ru/stek.md?raw";
import iskhodnyjKodRu from "../../content/help/ru/iskhodnyj-kod.md?raw";

import oProekteEn from "../../content/help/en/o-proekte.md?raw";
import kontaktyIKanalyEn from "../../content/help/en/kontakty-i-kanaly.md?raw";
import privatnostEn from "../../content/help/en/privatnost.md?raw";
import stekEn from "../../content/help/en/stek.md?raw";
import iskhodnyjKodEn from "../../content/help/en/iskhodnyj-kod.md?raw";

import oProekteEs from "../../content/help/es/o-proekte.md?raw";
import kontaktyIKanalyEs from "../../content/help/es/kontakty-i-kanaly.md?raw";
import privatnostEs from "../../content/help/es/privatnost.md?raw";
import stekEs from "../../content/help/es/stek.md?raw";
import iskhodnyjKodEs from "../../content/help/es/iskhodnyj-kod.md?raw";

import oProekteDe from "../../content/help/de/o-proekte.md?raw";
import kontaktyIKanalyDe from "../../content/help/de/kontakty-i-kanaly.md?raw";
import privatnostDe from "../../content/help/de/privatnost.md?raw";
import stekDe from "../../content/help/de/stek.md?raw";
import iskhodnyjKodDe from "../../content/help/de/iskhodnyj-kod.md?raw";

import oProekteJa from "../../content/help/ja/o-proekte.md?raw";
import kontaktyIKanalyJa from "../../content/help/ja/kontakty-i-kanaly.md?raw";
import privatnostJa from "../../content/help/ja/privatnost.md?raw";
import stekJa from "../../content/help/ja/stek.md?raw";
import iskhodnyjKodJa from "../../content/help/ja/iskhodnyj-kod.md?raw";

import oProekteFr from "../../content/help/fr/o-proekte.md?raw";
import kontaktyIKanalyFr from "../../content/help/fr/kontakty-i-kanaly.md?raw";
import privatnostFr from "../../content/help/fr/privatnost.md?raw";
import stekFr from "../../content/help/fr/stek.md?raw";
import iskhodnyjKodFr from "../../content/help/fr/iskhodnyj-kod.md?raw";

import oProektePt from "../../content/help/pt/o-proekte.md?raw";
import kontaktyIKanalyPt from "../../content/help/pt/kontakty-i-kanaly.md?raw";
import privatnostPt from "../../content/help/pt/privatnost.md?raw";
import stekPt from "../../content/help/pt/stek.md?raw";
import iskhodnyjKodPt from "../../content/help/pt/iskhodnyj-kod.md?raw";

import oProekteIt from "../../content/help/it/o-proekte.md?raw";
import kontaktyIKanalyIt from "../../content/help/it/kontakty-i-kanaly.md?raw";
import privatnostIt from "../../content/help/it/privatnost.md?raw";
import stekIt from "../../content/help/it/stek.md?raw";
import iskhodnyjKodIt from "../../content/help/it/iskhodnyj-kod.md?raw";

import oProekteNl from "../../content/help/nl/o-proekte.md?raw";
import kontaktyIKanalyNl from "../../content/help/nl/kontakty-i-kanaly.md?raw";
import privatnostNl from "../../content/help/nl/privatnost.md?raw";
import stekNl from "../../content/help/nl/stek.md?raw";
import iskhodnyjKodNl from "../../content/help/nl/iskhodnyj-kod.md?raw";

import oProektePl from "../../content/help/pl/o-proekte.md?raw";
import kontaktyIKanalyPl from "../../content/help/pl/kontakty-i-kanaly.md?raw";
import privatnostPl from "../../content/help/pl/privatnost.md?raw";
import stekPl from "../../content/help/pl/stek.md?raw";
import iskhodnyjKodPl from "../../content/help/pl/iskhodnyj-kod.md?raw";

import oProekteTr from "../../content/help/tr/o-proekte.md?raw";
import kontaktyIKanalyTr from "../../content/help/tr/kontakty-i-kanaly.md?raw";
import privatnostTr from "../../content/help/tr/privatnost.md?raw";
import stekTr from "../../content/help/tr/stek.md?raw";
import iskhodnyjKodTr from "../../content/help/tr/iskhodnyj-kod.md?raw";

import oProekteZh from "../../content/help/zh/o-proekte.md?raw";
import kontaktyIKanalyZh from "../../content/help/zh/kontakty-i-kanaly.md?raw";
import privatnostZh from "../../content/help/zh/privatnost.md?raw";
import stekZh from "../../content/help/zh/stek.md?raw";
import iskhodnyjKodZh from "../../content/help/zh/iskhodnyj-kod.md?raw";

const HELP_CONTENT = {
	ru: { "o-proekte": oProekteRu, "kontakty-i-kanaly": kontaktyIKanalyRu, privatnost: privatnostRu, stek: stekRu, "iskhodnyj-kod": iskhodnyjKodRu },
	en: { "o-proekte": oProekteEn, "kontakty-i-kanaly": kontaktyIKanalyEn, privatnost: privatnostEn, stek: stekEn, "iskhodnyj-kod": iskhodnyjKodEn },
	es: { "o-proekte": oProekteEs, "kontakty-i-kanaly": kontaktyIKanalyEs, privatnost: privatnostEs, stek: stekEs, "iskhodnyj-kod": iskhodnyjKodEs },
	de: { "o-proekte": oProekteDe, "kontakty-i-kanaly": kontaktyIKanalyDe, privatnost: privatnostDe, stek: stekDe, "iskhodnyj-kod": iskhodnyjKodDe },
	ja: { "o-proekte": oProekteJa, "kontakty-i-kanaly": kontaktyIKanalyJa, privatnost: privatnostJa, stek: stekJa, "iskhodnyj-kod": iskhodnyjKodJa },
	fr: { "o-proekte": oProekteFr, "kontakty-i-kanaly": kontaktyIKanalyFr, privatnost: privatnostFr, stek: stekFr, "iskhodnyj-kod": iskhodnyjKodFr },
	pt: { "o-proekte": oProektePt, "kontakty-i-kanaly": kontaktyIKanalyPt, privatnost: privatnostPt, stek: stekPt, "iskhodnyj-kod": iskhodnyjKodPt },
	it: { "o-proekte": oProekteIt, "kontakty-i-kanaly": kontaktyIKanalyIt, privatnost: privatnostIt, stek: stekIt, "iskhodnyj-kod": iskhodnyjKodIt },
	nl: { "o-proekte": oProekteNl, "kontakty-i-kanaly": kontaktyIKanalyNl, privatnost: privatnostNl, stek: stekNl, "iskhodnyj-kod": iskhodnyjKodNl },
	pl: { "o-proekte": oProektePl, "kontakty-i-kanaly": kontaktyIKanalyPl, privatnost: privatnostPl, stek: stekPl, "iskhodnyj-kod": iskhodnyjKodPl },
	tr: { "o-proekte": oProekteTr, "kontakty-i-kanaly": kontaktyIKanalyTr, privatnost: privatnostTr, stek: stekTr, "iskhodnyj-kod": iskhodnyjKodTr },
	zh: { "o-proekte": oProekteZh, "kontakty-i-kanaly": kontaktyIKanalyZh, privatnost: privatnostZh, stek: stekZh, "iskhodnyj-kod": iskhodnyjKodZh },
};

// Рубрикатор — чистые данные, порядок = порядок в жизненном цикле знакомства
// с проектом (сначала "что это", потом "как пользоваться", потом детали для
// продвинутых). titleKey (не готовый текст) — тот же приём, что NAV_ITEMS/
// CATEGORY_META (этап 64): заголовок переведён через t(titleKey) в рендере,
// сам файл темы не хранит текст.
//
// Вынесено из screens/help.jsx (без обёртки Screen) — переиспользуется ДО
// логина, на стартовой странице (unlock.jsx's <main>), и ПОСЛЕ логина
// (screens/help.jsx), чтобы не дублировать список тем в двух местах.
const TOPIC_DEFS = [
	{ id: "o-proekte", titleKey: "help.topics.oProekte" },
	{ id: "kontakty-i-kanaly", titleKey: "help.topics.kontaktyIKanaly" },
	{ id: "privatnost", titleKey: "help.topics.privatnost" },
	{ id: "stek", titleKey: "help.topics.stek" },
	{ id: "iskhodnyj-kod", titleKey: "help.topics.iskhodnyjKod" },
];

export default function HelpContent() {
	const [activeTopicId, setActiveTopicId] = useState(TOPIC_DEFS[0].id);
	// currentLocale.value читается здесь явно (не только внутри t()) — сама
	// подписка компонента на смену языка нужна и для выбора HELP_CONTENT[locale],
	// не только для переведённых заголовков.
	const locale = currentLocale.value;
	const localeContent = HELP_CONTENT[locale] ?? HELP_CONTENT.en;
	const topics = TOPIC_DEFS.map((def) => ({ ...def, title: t(def.titleKey), source: localeContent[def.id] }));
	const activeTopic = topics.find((topic) => topic.id === activeTopicId) ?? topics[0];

	return (
		<div class="help-layout">
			<nav class="help-rubricator" aria-label={t("help.topicsAria")}>
				<ul role="list">
					{topics.map((topic) => (
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
	);
}
