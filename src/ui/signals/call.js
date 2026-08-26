import { signal } from "@preact/signals";
import { createCallRuntime } from "../../domain/calls/call-runtime.js";
import { BUILD_DEFAULT_ICE_SERVERS } from "../../config.js";
import { readBootstrapEndpoints } from "../../domain/settings/bootstrap-endpoints.js";
import { loadUiSettings } from "../../domain/settings/ui-settings.js";
import { notifyAndLog } from "../../domain/notifications/journal.js";
import { navigateFromNotification } from "./notification-nav.js";
import { profiles } from "./contacts.js";
import { t } from "./i18n.js";

// Этап 48, п.6 — реактивный мост между call-runtime.js (UI-агностичный imperative
// shell) и Preact-компонентами. callState — ПОЛНЫЙ снимок FSM-состояния (не только
// имя — persistent-оверлей показывает peerPubkey/reason и т.п.), обновляется через
// onStateChange (EMIT), который call-runtime.js вызывает СРАЗУ после того, как сам
// применил переход — runtime.getState() в этот момент уже возвращает НОВОЕ состояние.
export const callState = signal({ name: "IDLE", role: null, sessionId: null, peerPubkey: null, polite: null, restartCount: 0, reason: null });
export const localMediaStream = signal(null);
export const remoteMediaStream = signal(null);

let runtime = null;
let myPubkeyRef = null;
let dbKeyRef = null;

function usernameFor(pubkeyHex) {
	const name = profiles.value[pubkeyHex]?.name?.trim();
	return name || `${pubkeyHex.slice(0, 8)}…`;
}

// Этап 48, п.7 — входящий звонок принудительно "sound" (notifier.js — тот же
// принцип, что moderation/бан), best-effort (сбой не должен ронять сам звонок).
async function notifyIncomingCall(peerPubkey) {
	try {
		const settings = await loadUiSettings(myPubkeyRef, dbKeyRef);
		const navTarget = { screen: "messages", contactPubkey: peerPubkey };
		const titleKey = "journal.incomingCallTitle";
		const titleParams = { username: usernameFor(peerPubkey) };
		await notifyAndLog(myPubkeyRef, dbKeyRef, settings, "calls", null, {
			title: t(titleKey, titleParams),
			body: "",
			titleKey,
			titleParams,
			navTarget,
			onClick: () => navigateFromNotification(navTarget),
		});
	} catch {
		// нет настроек/сети — звонок всё равно виден через CallOverlay, уведомление необязательно
	}
}

// Вызывается ОДИН раз из transport.js's connect() — тот же принцип, что
// configureDefaultBackend в app.jsx (этап 47): доменный/оркестрационный слой не
// знает о конкретном моменте входа в аккаунт, UI-обвязка подключает его сама.
export function configureCallRuntime({ myPubkey, privKey, publish, dbKey }) {
	myPubkeyRef = myPubkey;
	dbKeyRef = dbKey;
	runtime = createCallRuntime({
		myPubkey,
		privKey,
		publish,
		iceServers: (() => {
			const ice = readBootstrapEndpoints().iceServers;
			return ice.length ? ice : BUILD_DEFAULT_ICE_SERVERS;
		})(),
		onStateChange: (stateName) => {
			const snapshot = runtime.getState();
			callState.value = snapshot;
			if (stateName === "INCOMING_RINGING") {
				notifyIncomingCall(snapshot.peerPubkey);
			}
		},
		onLocalStream: (stream) => {
			localMediaStream.value = stream;
		},
		onRemoteStream: (stream) => {
			remoteMediaStream.value = stream;
		},
	});
}

export function placeCall(peerPubkey) {
	runtime?.placeCall(peerPubkey);
}
export function acceptCall() {
	runtime?.accept();
}
export function rejectCall() {
	runtime?.reject();
}
export function hangupCall() {
	runtime?.hangup();
}
export function dismissEndedCall() {
	runtime?.dismissEnded();
}

// Вызывается transport.js на каждое входящее kind 20075 (сигналинг звонка).
export function handleIncomingCallSignal(event) {
	runtime?.handleIncomingSignal(event);
}
