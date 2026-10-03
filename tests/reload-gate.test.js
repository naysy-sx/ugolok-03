import { test } from "node:test";
import assert from "node:assert/strict";
import { reloadBlockReason, createReloadScheduler } from "../src/ui/reload-gate.js";

// Минимальная имитация документа: атрибут шага входа и поля ввода.
function fakeDoc({ flow = null, inputs = [] } = {}) {
	const state = { flow, inputs };
	return {
		state,
		documentElement: { getAttribute: (n) => (n === "data-auth-flow" ? state.flow : null) },
		querySelectorAll: () => state.inputs,
	};
}
const input = (value, type = "text") => ({ type, value });

test("безопасно: никто не залогинен, шаг main, поля пусты", () => {
	assert.equal(reloadBlockReason({ loggedIn: false, doc: fakeDoc({ flow: "main", inputs: [input(""), input("", "password")] }) }), null);
	assert.equal(reloadBlockReason({ loggedIn: false, doc: fakeDoc({ flow: "loading" }) }), null);
	assert.equal(reloadBlockReason({ loggedIn: false, doc: fakeDoc() }), null);
});

test("нельзя: залогинен", () => {
	assert.equal(reloadBlockReason({ loggedIn: true, doc: fakeDoc() }), "session");
});

test("нельзя: идёт регистрация/импорт (любой шаг, кроме main и loading)", () => {
	for (const flow of ["create-generate", "create-confirm", "import-mnemonic", "import-key", "advanced-password", "done", "db-error"]) {
		assert.equal(reloadBlockReason({ loggedIn: false, doc: fakeDoc({ flow }) }), "auth-step", flow);
	}
});

test("нельзя: в текстовом поле или пароле что-то введено; кнопки и чекбоксы не в счёт", () => {
	assert.equal(reloadBlockReason({ loggedIn: false, doc: fakeDoc({ flow: "main", inputs: [input("tester")] }) }), "typed");
	assert.equal(reloadBlockReason({ loggedIn: false, doc: fakeDoc({ flow: "main", inputs: [input("", "text"), input("секрет", "password")] }) }), "typed");
	assert.equal(reloadBlockReason({ loggedIn: false, doc: fakeDoc({ flow: "main", inputs: [input("on", "checkbox"), input("Войти", "submit")] }) }), null);
});

function harness({ loggedIn = false, doc = fakeDoc({ flow: "main" }) } = {}) {
	const env = { doc, loggedIn, reloads: 0, lockCbs: [], timers: [] };
	const sched = createReloadScheduler({
		doc,
		isLoggedIn: () => env.loggedIn,
		onceOnLock: (fn) => env.lockCbs.push(fn),
		reload: () => env.reloads++,
		setTimeoutFn: (fn) => env.timers.push(fn),
	});
	env.sched = sched;
	env.runTimers = () => {
		const t = env.timers.splice(0);
		t.forEach((f) => f());
	};
	return env;
}

test("на пустом стартовом экране перезагрузка выполняется сразу", () => {
	const h = harness();
	h.sched.request();
	assert.equal(h.reloads, 1);
});

test("баг «поля стёрлись»: пока идёт ввод, перезагрузки нет; после очистки — выполняется", () => {
	const doc = fakeDoc({ flow: "main", inputs: [input("tester")] });
	const h = harness({ doc });
	h.sched.request();
	assert.equal(h.reloads, 0);
	h.runTimers();
	assert.equal(h.reloads, 0, "поле всё ещё заполнено");
	doc.state.inputs = [input("")];
	h.runTimers();
	assert.equal(h.reloads, 1);
});

test("баг «после регистрации/входа выкинуло»: перезагрузка не срабатывает, когда экран входа исчез из-за входа", () => {
	const doc = fakeDoc({ flow: "advanced-password", inputs: [input("")] });
	const h = harness({ doc });
	h.sched.request();
	assert.equal(h.reloads, 0, "идёт регистрация");
	// человек завершил регистрацию и вошёл: экран входа исчез, сессия жива
	doc.state.flow = null;
	doc.state.inputs = [];
	h.loggedIn = true;
	h.runTimers();
	assert.equal(h.reloads, 0, "сессия жива — не рвём");
	assert.equal(h.lockCbs.length, 1, "ждём блокировки");
});

test("при живой сессии перезагрузка происходит после блокировки", () => {
	const h = harness({ loggedIn: true });
	h.sched.request();
	assert.equal(h.reloads, 0);
	assert.equal(h.lockCbs.length, 1);
	h.loggedIn = false; // lock() сбросил сессию
	h.lockCbs[0]();
	h.runTimers();
	assert.equal(h.reloads, 1);
});

test("повторные запросы не плодят ожиданий и перезагрузок", () => {
	const h = harness({ loggedIn: true });
	h.sched.request();
	h.sched.request();
	h.sched.request();
	assert.equal(h.lockCbs.length, 1);
	assert.equal(h.reloads, 0);
});
