import { test } from "node:test";
import assert from "node:assert/strict";
import { logInfo, logWarn, logError, getBootLog, countProblems, subscribeBootLog, resetBootLogForTests } from "../src/core/diag/boot-log.js";

test("boot-log: countProblems считает только warn и error", () => {
	resetBootLogForTests();
	logInfo("a");
	logInfo("b");
	logWarn("c");
	logError("d");
	assert.equal(getBootLog().length, 4);
	assert.equal(countProblems(), 2);
});

test("boot-log: буфер не растёт бесконечно", () => {
	resetBootLogForTests();
	for (let i = 0; i < 500; i += 1) logInfo(`line ${i}`);
	const lines = getBootLog();
	assert.equal(lines.length, 200);
	assert.equal(lines.at(-1).message, "line 499");
});

test("boot-log: отписка перестаёт получать уведомления", () => {
	resetBootLogForTests();
	let calls = 0;
	const unsubscribe = subscribeBootLog(() => {
		calls += 1;
	});
	logInfo("a");
	unsubscribe();
	logInfo("b");
	assert.equal(calls, 1);
});
