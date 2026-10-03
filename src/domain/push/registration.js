// src/domain/push/registration.js — Э-PUSH П3.2/П3.3 (TZ-PUSH-ANDROID.md).
// Регистрация на мосту (POST/PUT/DELETE /push/register, push-bridge-client.js,
// П1) + передача результата нативному слою (platform.push.syncFilters, П2).
//
// Ограничение архитектуры хранения ключей (Р5 — приватный ключ не хранится
// вне памяти, src/ui/signals/auth.js's privKeySig): в любой момент времени в
// памяти расшифрован приватный ключ максимум ОДНОГО аккаунта — того, что
// сейчас разблокирован. ТЗ пишет "для каждого локального аккаунта" буквально
// как будто это пакетная операция по списку — технически невозможно без
// повторного ввода пароля на каждый. Решение: регистрация/продление/удаление
// происходят ПО ОДНОМУ аккаунту, в момент когда его ключ реально в памяти
// (login, явное включение, удаление аккаунта) — см. функции ниже. Данные
// остальных аккаунтов на этом устройстве (endpoint/topic от прошлой
// регистрации) хранятся локально и используются для синхронизации нативного
// списка топиков (applyNativeTopics) без необходимости их ключа.
//
// "Выход из аккаунта" (lock(), src/ui/signals/auth.js) НАМЕРЕННО не вызывает
// unregister: lock() срабатывает и на обычный 24-часовой idle-таймаут
// (startIdleWatcher) — если бы это снимало регистрацию, push переставал бы
// работать именно тогда, когда он нужнее всего (приложение не на экране).
// Единственное реальное "ушёл навсегда" в этой кодовой базе — удаление
// аккаунта (account-deletion.js), туда и подключено (unregisterPushForAccount).
import { getPlatform } from "../../platform/index.js";
import { getRuntimeConfig } from "../settings/runtime-config.js";
import { registerPush, updatePushFilters, unregisterPush } from "../../core/transport/push-bridge-client.js";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";

const ENABLED_KEY = "ugolok:push.enabled";
const REGISTRATIONS_KEY = "ugolok:push.registrations";
const ONBOARDING_SEEN_KEY = "ugolok:push.onboardingSeen";

// П3.2 «продление раз в неделю при запуске».
export const RENEWAL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// П3.3 «склеивать изменения [фильтров], не чаще раза в минуту».
export const FILTER_SYNC_DEBOUNCE_MS = 60 * 1000;

// typeof-гварды — тот же приём, что src/core/diag/call-trace.js: под node:test
// (и в любом окружении без localStorage) весь модуль должен вести себя как
// "ничего не зарегистрировано", а не бросать ReferenceError — иначе ЛЮБОЙ
// тест, который транзитивно задевает deleteAccountEverywhere/login (а не
// именно push), падал бы из-за модуля, которым не интересуется.
function readRegistrations() {
	if (typeof localStorage === "undefined") return {};
	try {
		return JSON.parse(localStorage.getItem(REGISTRATIONS_KEY)) ?? {};
	} catch {
		return {};
	}
}

function writeRegistrations(map) {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(REGISTRATIONS_KEY, JSON.stringify(map));
}

function groupsKey(groupIds) {
	return [...groupIds].sort().join(",");
}

export async function getMyGroupIds(ownerPubkey, dbKey) {
	const rows = await db.table("mlsGroups").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.map((row) => fromEncryptedRow(row, dbKey).groupId);
}

// options.platform — тестовый шов (тот же приём, что options.fetchImpl у
// push-bridge-client.js): настоящий getPlatform() в Node-тестах регистрирует
// реальный Capacitor-мост к несуществующему нативному слою и падает на первом
// же вызове enable/syncFilters. Продакшен-код всегда зовёт без этого параметра.
function resolvePlatform(options) {
	return options.platform ?? getPlatform();
}

// available() уже учитывает сервер (config.json.pushBridge, capacitor.js);
// os==="android" добавлен здесь — available() сам по себе не различает
// Android от гипотетического будущего iOS-Capacitor (П3.1, А-Explore).
export function isPushSupported(options = {}) {
	const platform = resolvePlatform(options);
	return platform.os === "android" && platform.push.available();
}

export function isPushEnabled() {
	if (typeof localStorage === "undefined") return false;
	return localStorage.getItem(ENABLED_KEY) === "1";
}

function setEnabledFlag(enabled) {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
}

// П3.5 «одноразовое ненавязчивое предложение включить функцию» — device-local
// (не per-account/не через ui-settings.js): это чисто "не надоедать на ЭТОМ
// устройстве", не настройка, которую имеет смысл синхронизировать между
// устройствами одного владельца ключа.
export function hasSeenPushOnboarding() {
	if (typeof localStorage === "undefined") return true;
	return localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
}

export function markPushOnboardingSeen() {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
}

// applyNativeTopics — единственное место, где зовётся platform.push.enable/
// disable/syncFilters: нативный сервис держит ОДИН список топиков на ВСЕ
// аккаунты сразу (П2.1 "мультиаккаунт — один топик на аккаунт" в одном
// соединении), поэтому любое изменение набора регистраций пересобирает и
// отправляет список целиком, а не инкрементально.
async function applyNativeTopics(options = {}) {
	const platform = resolvePlatform(options);
	if (!platform.push) return;
	const regs = readRegistrations();
	const topics = Object.entries(regs).map(([accountId, r]) => ({ accountId, endpoint: r.endpoint }));
	if (topics.length === 0) {
		await platform.push.disable();
		return;
	}
	await platform.push.enable();
	await platform.push.syncFilters(topics);
}

// Первое включение функции (П3.5) И первая регистрация аккаунта, который
// ещё не видели, пока функция уже включена (мультиаккаунт, Ворота П3).
export async function enablePushForAccount(ownerPubkey, privKey, dbKey, options = {}) {
	if (!isPushSupported(options)) return null;
	const bridgeUrl = getRuntimeConfig().pushBridge;
	if (!bridgeUrl) return null;

	const groups = await getMyGroupIds(ownerPubkey, dbKey);
	const result = await registerPush(bridgeUrl, groups, privKey, options);

	const regs = readRegistrations();
	regs[ownerPubkey] = {
		endpoint: result.endpoint,
		topic: result.topic,
		expiresAt: result.expires_at,
		groupsKey: groupsKey(groups),
		renewedAt: options.now ?? Date.now(),
	};
	writeRegistrations(regs);
	setEnabledFlag(true);
	await applyNativeTopics(options);
	return result;
}

// Глобальный тумблер "выключить" (П3.4/П4.2 сценарий 5). Удаляет на мосту
// регистрацию ТОЛЬКО текущего разблокированного аккаунта (единственный ключ
// в памяти — см. комментарий файла); регистрации других аккаунтов этого
// устройства (если были) останутся до истечения TTL на мосту (30 дней) —
// честное ограничение, не баг.
export async function disablePushEverywhere(ownerPubkey, privKey, options = {}) {
	const bridgeUrl = getRuntimeConfig().pushBridge;
	if (bridgeUrl && ownerPubkey && privKey) {
		try {
			await unregisterPush(bridgeUrl, privKey, options);
		} catch {
			// best-effort — отказ сети не должен мешать пользователю выключить
			// функцию локально прямо сейчас
		}
	}
	writeRegistrations({});
	setEnabledFlag(false);
	await applyNativeTopics(options);
}

// Удаление ОДНОГО аккаунта (account-deletion.js) — остальные аккаунты и
// глобальный тумблер не трогаются.
export async function unregisterPushForAccount(ownerPubkey, privKey, options = {}) {
	const regs = readRegistrations();
	if (!regs[ownerPubkey]) return;
	const bridgeUrl = getRuntimeConfig().pushBridge;
	if (bridgeUrl && privKey) {
		try {
			await unregisterPush(bridgeUrl, privKey, options);
		} catch {
			// best-effort, см. disablePushEverywhere
		}
	}
	delete regs[ownerPubkey];
	writeRegistrations(regs);
	await applyNativeTopics(options);
}

// Вызывать при каждом login() (П3.2 «продление раз в неделю при запуске»).
// Не делает сетевых вызовов, если функция выключена/не поддерживается/этот
// аккаунт уже свежий — безопасно звать безусловно на каждый вход.
export async function syncPushOnLogin(ownerPubkey, privKey, dbKey, options = {}) {
	if (!isPushEnabled() || !isPushSupported(options)) return;
	const bridgeUrl = getRuntimeConfig().pushBridge;
	if (!bridgeUrl) return;

	const regs = readRegistrations();
	const existing = regs[ownerPubkey];
	const now = options.now ?? Date.now();

	if (!existing) {
		await enablePushForAccount(ownerPubkey, privKey, dbKey, options);
		return;
	}
	if (now - existing.renewedAt >= RENEWAL_INTERVAL_MS) {
		const groups = await getMyGroupIds(ownerPubkey, dbKey);
		const result = await updatePushFilters(bridgeUrl, groups, privKey, options);
		regs[ownerPubkey] = { ...existing, expiresAt: result.expires_at, groupsKey: groupsKey(groups), renewedAt: now };
		writeRegistrations(regs);
	}
	await applyNativeTopics(options);
}

const pendingFilterSync = new Map(); // ownerPubkey -> timer handle

// П3.3. Вызывать из мест, где уже известен текущий список групп (например
// refreshGroupMessageSubscription, transport.js) — groupIds передаётся
// готовым, не пересчитывается здесь на каждый вызов (та функция зовётся и на
// обычную отправку сообщения, не только на реальное изменение состава
// групп — лишний запрос к БД на каждый чих был бы расточительным). Сравнение
// строки — дешёвая проверка "действительно ли список изменился" перед тем,
// как вообще думать о сети.
export function notifyGroupsMayHaveChanged(ownerPubkey, privKey, dbKey, groupIds, options = {}) {
	if (!isPushEnabled() || !isPushSupported(options)) return;
	const bridgeUrl = getRuntimeConfig().pushBridge;
	if (!bridgeUrl) return;

	const regs = readRegistrations();
	const existing = regs[ownerPubkey];
	if (!existing) return; // ещё не зарегистрирован — обычная регистрация возьмёт текущий список сама

	if (groupsKey(groupIds) === existing.groupsKey) return;
	if (pendingFilterSync.has(ownerPubkey)) return; // уже запланировано — склейка (П3.3)

	const schedule = options.setTimeoutImpl ?? setTimeout;
	const delay = options.debounceMs ?? FILTER_SYNC_DEBOUNCE_MS;

	const timer = schedule(async () => {
		pendingFilterSync.delete(ownerPubkey);
		try {
			// Перечитываем СВЕЖИЙ список на момент срабатывания — то, что пришло
			// параметром при планировании, могло устареть за время окна склейки.
			const freshGroups = await getMyGroupIds(ownerPubkey, dbKey);
			const freshRegs = readRegistrations();
			const current = freshRegs[ownerPubkey];
			if (!current) return; // отключили/удалили аккаунт, пока ждали таймер
			const freshKey = groupsKey(freshGroups);
			if (freshKey === current.groupsKey) return;
			const result = await updatePushFilters(bridgeUrl, freshGroups, privKey, options);
			freshRegs[ownerPubkey] = { ...current, expiresAt: result.expires_at, groupsKey: freshKey, renewedAt: options.now ?? Date.now() };
			writeRegistrations(freshRegs);
		} catch {
			// best-effort — следующее реальное изменение групп попробует снова;
			// соответствует ИП7-принципу: сбой push не должен быть виден остальному приложению
		}
	}, delay);

	pendingFilterSync.set(ownerPubkey, timer);
}

// Тестовый хук — не экспортируется в обычных доменных модулях этого проекта
// намеренно скупо, но pendingFilterSync — модульный Map, переживающий между
// тестами в одном процессе без явного сброса.
export function resetPushRegistrationStateForTests() {
	for (const timer of pendingFilterSync.values()) clearTimeout(timer);
	pendingFilterSync.clear();
}
