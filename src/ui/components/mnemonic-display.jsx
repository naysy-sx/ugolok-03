import { useState } from "preact/hooks";
import IconCopy from "../icons/copy.jsx";
import IconCheck from "../icons/check.jsx";
import { t } from "../signals/i18n.js";

// Пользователь — три правки разом:
// 1) auto-fit/minmax вместо жёстких repeat(4,1fr) — тот же приём, что
//    композиционный .grid (minimal.css), только с своим --min под ширину
//    слова мнемоники: на узких экранах колонки сами убывают (4 -> 3 -> 2 -> 1),
//    без единого @media/@container — попросил явно "изящный способ без
//    media queries".
// 2) padding-inline-start:0 — list-style-position:inside ("1. слово" одной
//    строкой) НЕ убирает штатный отступ браузера под маркер, тот остаётся
//    висеть слева пустым.
// 3) Кнопка копирования — сама фраза, БЕЗ номеров, слова через пробел
//    (то, что реально нужно вставить при восстановлении).
const COPY_RESET_MS = 2000;

export default function MnemonicDisplay({ words }) {
	const [copied, setCopied] = useState(false);

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(words.join(" "));
			setCopied(true);
			setTimeout(() => setCopied(false), COPY_RESET_MS);
		} catch {
			// буфер обмена недоступен (разрешение/контекст) — молча, слова и так видны на экране
		}
	}

	return (
		<div class="mnemonic-display">
			<button
				type="button"
				class={`icon-btn mnemonic-display__copy${copied ? " icon-btn--good" : ""}`}
				onClick={handleCopy}
				aria-label={t(copied ? "unlock.createGenerate.copiedButton" : "unlock.createGenerate.copyButton")}
			>
				{copied ? <IconCheck /> : <IconCopy />}
			</button>
			<ol class="mnemonic-display__list">
				{words.map((word, i) => (
					<li key={i}>{word}</li>
				))}
			</ol>
		</div>
	);
}
