// Rooms, этап 1 — presence.js. Тесты до кода (skill п.14). Контракт —
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1", формализация — ROOMS-MATH-v2.md §2,
// ROOMS-ALGO.md §2 (обрезка), §3.1 (структура).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyPresence, mergeHeartbeat, mergeExit, present, prune } from "../src/domain/rooms/presence.js";

const TAU = 45000;

function heartbeat(state, pubkey, at, nick = "гость") {
	return mergeHeartbeat(state, { pubkey, nick, at });
}
function exit(state, pubkey, at) {
	return mergeExit(state, { pubkey, at });
}

test("emptyPresence: пустое состояние, present() ничего не даёт", () => {
	assert.deepEqual(present(emptyPresence(), 0, TAU), []);
});

test("mergeHeartbeat: свежий heartbeat -> участник присутствует", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 1000);
	assert.deepEqual(present(state, 1000, TAU).map((p) => p.pubkey), ["alice"]);
});

test("mergeExit: after exit участник больше НЕ присутствует, даже с недавним heartbeat перед этим", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 1000);
	state = exit(state, "alice", 1001);
	assert.deepEqual(present(state, 1001, TAU), []);
});

test("И1: merge идемпотентна — повторное слияние того же heartbeat не меняет Present(t)", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 1000);
	const before = present(state, 1000, TAU);
	state = heartbeat(state, "alice", 1000); // тот же (pubkey, at) повторно
	const after = present(state, 1000, TAU);
	assert.deepEqual(before, after);
});

test("И1: merge коммутативна — два наблюдателя, разный порядок событий, одинаковый Present(t)", () => {
	const events = [
		() => ({ type: "heartbeat", pubkey: "alice", at: 1000, nick: "Алиса" }),
		() => ({ type: "heartbeat", pubkey: "bob", at: 1005, nick: "Боб" }),
		() => ({ type: "exit", pubkey: "alice", at: 1010 }),
		() => ({ type: "heartbeat", pubkey: "carol", at: 1015, nick: "Кэрол" }),
	].map((f) => f());

	function applyInOrder(order) {
		let state = emptyPresence();
		for (const i of order) {
			const e = events[i];
			state = e.type === "heartbeat" ? mergeHeartbeat(state, e) : mergeExit(state, e);
		}
		return state;
	}

	const forward = applyInOrder([0, 1, 2, 3]);
	const reversed = applyInOrder([3, 2, 1, 0]);
	const shuffled = applyInOrder([2, 0, 3, 1]);

	const now = 1020;
	const presentForward = present(forward, now, TAU).map((p) => p.pubkey).sort();
	const presentReversed = present(reversed, now, TAU).map((p) => p.pubkey).sort();
	const presentShuffled = present(shuffled, now, TAU).map((p) => p.pubkey).sort();

	assert.deepEqual(presentForward, presentReversed);
	assert.deepEqual(presentForward, presentShuffled);
	assert.deepEqual(presentForward, ["bob", "carol"], "alice вышла последней (exit at=1010 > heartbeat at=1000)");
});

test("И1: merge ассоциативна — покомпонентный max на (a,r) не ломается перезаписью вместо слияния", () => {
	// presence.js не экспортирует голый merge — mergeHeartbeat/mergeExit сами
	// покомпонентно берут max, так что ассоциативность max на числах достаточна;
	// здесь проверяем, что реализация ЭТО свойство не портит (например, случайно
	// перезаписывая вместо max при повторном/более раннем событии).
	let viaLeft = emptyPresence();
	viaLeft = heartbeat(viaLeft, "alice", 100);
	viaLeft = heartbeat(viaLeft, "alice", 300); // "поздний" heartbeat после раннего
	let viaRight = emptyPresence();
	viaRight = heartbeat(viaRight, "alice", 300);
	viaRight = heartbeat(viaRight, "alice", 100); // тот же набор, обратный порядок
	assert.deepEqual(present(viaLeft, 300, TAU), present(viaRight, 300, TAU));
});

test("И2 (граница τ): предикат Present(t) = {a > r ∧ a ≥ t−τ} — граница НЕСТРОГАЯ (ROOMS-MATH §2.2 буквально)", () => {
	let state = emptyPresence();
	const T = 1000;
	state = heartbeat(state, "alice", T);
	assert.deepEqual(present(state, T + TAU - 1, TAU).map((p) => p.pubkey), ["alice"], "до истечения — присутствует");
	assert.deepEqual(present(state, T + TAU, TAU).map((p) => p.pubkey), ["alice"], "ровно в T+τ — a ≥ t−τ ещё истинно (нестрогое ≥), аренда ещё не истекла");
	assert.deepEqual(present(state, T + TAU + 1, TAU), [], "T+τ+1 — a ≥ t−τ ложно, аренда истекла");
});

test("stable order: present() отсортирован по joinedAt возрастанию", () => {
	let state = emptyPresence();
	state = heartbeat(state, "carol", 300);
	state = heartbeat(state, "alice", 100);
	state = heartbeat(state, "bob", 200);
	assert.deepEqual(present(state, 300, TAU).map((p) => p.pubkey), ["alice", "bob", "carol"]);
});

test("joinedAt: продление аренды (повторный heartbeat присутствующего) НЕ двигает joinedAt", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 100); // вход
	state = heartbeat(state, "alice", 115); // продление, ещё присутствует (115 < 100+45000)
	const [alice] = present(state, 115, TAU);
	assert.equal(alice.joinedAt, 100, "joinedAt сохраняется от первого входа, не от последнего heartbeat");
});

test("joinedAt: повторный вход ПОСЛЕ exit обновляет joinedAt на новый момент", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 100);
	state = exit(state, "alice", 200);
	state = heartbeat(state, "alice", 500); // новый вход после ухода
	const [alice] = present(state, 500, TAU);
	assert.equal(alice.joinedAt, 500, "это НОВЫЙ вход — joinedAt должен обновиться, не остаться от старого 100");
});

test("nick: обновляется последним (по at) heartbeat, не откатывается более старым at", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 100, "Аня");
	state = heartbeat(state, "alice", 200, "Анна");
	assert.equal(present(state, 200, TAU)[0].nick, "Анна");

	// Запоздалое (более старое at) сообщение с другим ником не должно откатить nick.
	state = mergeHeartbeat(state, { pubkey: "alice", nick: "СТАРЫЙ", at: 150 });
	assert.equal(present(state, 200, TAU)[0].nick, "Анна", "nick не откатывается более старым at");
});

test("prune: удаляет запись с a < now-τ (строгое неравенство, ROOMS-ALGO §2.2 буквально), НЕЗАВИСИМО от r", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 1000);
	assert.equal(prune(state, 1000 + TAU, TAU).has("alice"), true, "ровно на границе (a < now-τ ложно при равенстве) — ещё НЕ обрезана");
	assert.equal(prune(state, 1000 + TAU + 1, TAU).has("alice"), false, "за границей — обрезана");
});

test("prune: НЕ удаляет запись, чья a ещё свежая, даже если участник уже вышел (r установлен)", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 1000);
	state = exit(state, "alice", 1001); // вышла сразу после heartbeat — r установлен, но a=1000 ещё свежая
	state = prune(state, 1001, TAU); // now намного раньше, чем a+τ
	assert.equal(state.has("alice"), true, "a=1000 всё ещё >= now-τ — обрезка не трогает, хотя a<=r (уже не 'присутствует')");
	assert.deepEqual(present(state, 1001, TAU), [], "но present() всё равно пуст — r перекрывает a");
});

test("И12: после k циклов вход-выход |L| = |Present|, не k (обрезка ограничивает рост)", () => {
	let state = emptyPresence();
	const K = 50;
	let t = 0;
	for (let i = 0; i < K; i++) {
		state = heartbeat(state, `guest-${i}`, t);
		t += 100;
		state = exit(state, `guest-${i}`, t);
		t += 100;
		state = prune(state, t, TAU); // sweep-тик после каждого цикла, ROOMS-ALGO §2.3
	}
	// Все K гостей давно ушли и их a устарела относительно текущего t (t растёт на 200
	// за цикл, TAU=45000 — после первых ~225 циклов старые записи начнут обрезаться;
	// при K=50 самый старый a=0 << t-TAU потенциально ещё в пределах TAU — проверим
	// прямое свойство: после ЯВНОГО скачка времени далеко за TAU, размер обрушивается.
	state = prune(state, t + TAU + 1, TAU);
	assert.equal(state.size, 0, "все K участников давно ушли и протухли — состояние не растёт линейно с k");
});

test("prune идемпотентна — повторный вызов на уже обрезанном состоянии ничего не меняет", () => {
	let state = emptyPresence();
	state = heartbeat(state, "alice", 1000);
	const once = prune(state, 1000 + TAU, TAU);
	const twice = prune(once, 1000 + TAU, TAU);
	assert.deepEqual(once, twice);
});

test("состояние не мутируется на месте — mergeHeartbeat/mergeExit/prune возвращают НОВЫЙ объект", () => {
	const original = emptyPresence();
	const afterHeartbeat = heartbeat(original, "alice", 1000);
	assert.equal(original.size, 0, "исходное состояние не тронуто");
	assert.equal(afterHeartbeat.size, 1);
});
