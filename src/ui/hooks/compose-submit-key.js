// Enter отправляет сообщение в textarea-композере, Shift+Enter — перевод
// строки. isComposing — защита от IME: во время предиктивного ввода Enter
// подтверждает вариант, а не завершает сообщение. Тот же инвариант, что
// в quick.jsx.
export function isComposeSubmitKey(e) {
	return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}
