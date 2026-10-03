// Безопасный момент автоматической перезагрузки страницы (после обновления service worker
// или закрытия базы другой вкладкой).
//
// Раньше перезагрузка «откладывалась» только пока виден экран входа (.auth-layout), и это
// било по пользователю дважды:
//  * шаги регистрации (показ сид-фразы, подтверждение, пароль) этого экрана не имеют, поэтому
//    страница перезагружалась посреди регистрации и стирала введённое (и показанную, ещё не
//    сохранённую сид-фразу);
//  * отложенная перезагрузка срабатывала в момент, когда экран входа исчезал, то есть сразу
//    ПОСЛЕ успешного входа: ключи из памяти пропадали, и человек снова видел форму входа.
//
// Теперь перезагрузка происходит только когда терять нечего:
//  * пока кто-то залогинен — не вообще, а после блокировки (тогда на экране пусто);
//  * пока идёт регистрация/импорт (шаг не «main» и не «loading») — ждём;
//  * пока в любом текстовом поле что-то введено — ждём.

const NON_TEXT_INPUT = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "hidden", "range", "color", "image"]);

// Причина, по которой перезагружаться нельзя, либо null, если безопасно.
export function reloadBlockReason({ loggedIn, doc }) {
	if (loggedIn) return "session";
	const flow = doc.documentElement?.getAttribute?.("data-auth-flow");
	if (flow && flow !== "main" && flow !== "loading") return "auth-step";
	for (const el of doc.querySelectorAll("input, textarea")) {
		const type = String(el.type || "text").toLowerCase();
		if (NON_TEXT_INPUT.has(type)) continue;
		if (String(el.value ?? "").length > 0) return "typed";
	}
	return null;
}

// env: { doc, isLoggedIn(), onceOnLock(fn), reload(), setTimeoutFn?, pollMs? }
export function createReloadScheduler(env) {
	const setT = env.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
	const pollMs = env.pollMs ?? 2000;
	let requested = false;
	let waitingForLock = false;

	function tick() {
		const reason = reloadBlockReason({ loggedIn: env.isLoggedIn(), doc: env.doc });
		if (reason === null) {
			env.reload();
			return;
		}
		if (reason === "session") {
			// Сессия жива — не рвём её. Обновление применится, когда человек (или таймер
			// бездействия) заблокирует приложение: тогда на экране пусто.
			if (!waitingForLock) {
				waitingForLock = true;
				env.onceOnLock(() => {
					waitingForLock = false;
					// хук блокировки вызывается до сброса сигналов — даём ему завершиться
					setT(tick, 0);
				});
			}
			return;
		}
		setT(tick, pollMs);
	}

	return {
		// Запросить перезагрузку «при первой возможности» (повторные запросы игнорируются).
		request() {
			if (requested) return;
			requested = true;
			tick();
		},
	};
}
