import { listInboxRequests, acceptInboxRequest, rejectInboxRequest } from "../../domain/messaging/inbox-requests.js";
import { openChat } from "./chat.js";

export async function refreshInboxRequests(ownerPubkey) {
	return listInboxRequests(ownerPubkey);
}

// Находка 3 (CONTRACTS.md, этап 27): acceptInboxRequest сама не подписывает устройство
// на #h новой MLS-группы — вызывающий код обязан вызвать refreshGroupMessageSubscription
// сразу следом (тот же принцип, что ensureChatEstablished, этап 24).
export async function acceptInboxRequestAction(ownerPubkey, privKey, dbKey, senderPubkey, refreshGroupMessageSubscription, publish) {
	await acceptInboxRequest(ownerPubkey, dbKey, senderPubkey);
	await refreshGroupMessageSubscription(ownerPubkey, privKey, publish);
	openChat(senderPubkey);
}

export async function rejectInboxRequestAction(ownerPubkey, senderPubkey) {
	await rejectInboxRequest(ownerPubkey, senderPubkey);
}
