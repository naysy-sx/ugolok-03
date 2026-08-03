// Этап 65 — i18n доменных ошибок. message остаётся как раньше (русский
// текст) — существующие тесты матчат его regex'ом на фрагмент, менять
// нельзя (см. CONTRACTS.md, "Этап 65"); key/params — ДОПОЛНИТЕЛЬНЫЕ поля
// для UI-слоя (errorMessage() в ui/signals/i18n.js), рендерят перевод при
// наличии key, иначе показывают message как раньше (обратная совместимость
// с ошибками, для которых key не задан — например "чужой" текст от relay).
export class DomainError extends Error {
	constructor(message, key, params) {
		super(message);
		this.name = "DomainError";
		this.key = key;
		this.params = params;
	}
}
