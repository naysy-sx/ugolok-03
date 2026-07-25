export function reduce(peerState, event) {
  const now = Math.floor(Date.now() / 1000);

  switch (peerState.name) {
    case "NONE":
      if (event.type === "USER_SEND_REQUEST") {
        return {
          state: { ...peerState, name: "OUTGOING_PENDING" },
          commands: [
            { type: "PUBLISH_REQUEST", peer: event.peer, greeting: event.greeting },
            { type: "UPSERT", peer: event.peer, fields: {} },
            { type: "EMIT", peer: event.peer, stateName: "OUTGOING_PENDING" },
          ],
        };
      }
      if (event.type === "REMOTE_REQUEST") {
        return {
          state: { ...peerState, name: "INCOMING_PENDING", greeting: event.greeting, resolvedAt: peerState.resolvedAt || 0 },
          commands: [
            { type: "UPSERT", peer: event.peer, fields: { greeting: event.greeting, createdAt: event.createdAt } },
            { type: "EMIT", peer: event.peer, stateName: "INCOMING_PENDING" },
          ],
        };
      }
      break;

    case "OUTGOING_PENDING":
      if (event.type === "REMOTE_ACCEPT" && event.createdAt > peerState.resolvedAt) {
        return {
          state: { ...peerState, name: "CONTACT", resolvedAt: event.createdAt },
          commands: [
            { type: "UPDATE_CONTACTS_LIST", peer: event.peer, action: "add" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: event.createdAt } },
            { type: "LOG_JOURNAL", entry: { peer: event.peer, message: "принял(а) вашу заявку" } },
            { type: "EMIT", peer: event.peer, stateName: "CONTACT" },
          ],
        };
      }
      if (event.type === "REMOTE_REJECT" && event.createdAt > peerState.resolvedAt) {
        return {
          state: { ...peerState, name: "NONE", resolvedAt: event.createdAt },
          commands: [
            { type: "DELETE", peer: event.peer },
            { type: "LOG_JOURNAL", entry: { peer: event.peer, message: "отклонил(а) вашу заявку" } },
            { type: "EMIT", peer: event.peer, stateName: "NONE" },
          ],
        };
      }
      if (event.type === "REMOTE_REQUEST" && event.createdAt > peerState.resolvedAt) {
        return {
          state: { ...peerState, name: "CONTACT", resolvedAt: event.createdAt },
          commands: [
            { type: "UPDATE_CONTACTS_LIST", peer: event.peer, action: "add" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: event.createdAt } },
            { type: "LOG_JOURNAL", entry: { peer: event.peer, message: "вы теперь контакты — заявки совпали" } },
            { type: "EMIT", peer: event.peer, stateName: "CONTACT" },
          ],
        };
      }
      if (event.type === "USER_CANCEL") {
        return {
          state: { ...peerState, name: "NONE" },
          commands: [
            { type: "PUBLISH_CANCEL", peer: event.peer },
            { type: "DELETE", peer: event.peer },
            { type: "EMIT", peer: event.peer, stateName: "NONE" },
          ],
        };
      }
      if (event.type === "USER_BLOCK") {
        return {
          state: { ...peerState, name: "BLOCKED", resolvedAt: now },
          commands: [
            { type: "PUBLISH_CANCEL", peer: event.peer },
            { type: "UPDATE_MUTE_LIST", peer: event.peer, action: "add" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: now } },
            { type: "EMIT", peer: event.peer, stateName: "BLOCKED" },
          ],
        };
      }
      break;

    case "INCOMING_PENDING":
      if (event.type === "USER_ACCEPT") {
        return {
          state: { ...peerState, name: "CONTACT", resolvedAt: now },
          commands: [
            { type: "PUBLISH_ACCEPT", peer: event.peer },
            { type: "UPDATE_CONTACTS_LIST", peer: event.peer, action: "add" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: now } },
            { type: "EMIT", peer: event.peer, stateName: "CONTACT" },
          ],
        };
      }
      if (event.type === "USER_SEND_REQUEST") {
        return {
          state: { ...peerState, name: "CONTACT", resolvedAt: now },
          commands: [
            { type: "PUBLISH_ACCEPT", peer: event.peer },
            { type: "UPDATE_CONTACTS_LIST", peer: event.peer, action: "add" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: now } },
            { type: "EMIT", peer: event.peer, stateName: "CONTACT" },
          ],
        };
      }
      if (event.type === "USER_REJECT") {
        return {
          state: { ...peerState, name: "REJECTED_BY_ME", resolvedAt: now },
          commands: [
            { type: "PUBLISH_REJECT", peer: event.peer },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: now } },
            { type: "EMIT", peer: event.peer, stateName: "REJECTED_BY_ME" },
          ],
        };
      }
      if (event.type === "USER_BLOCK") {
        return {
          state: { ...peerState, name: "BLOCKED", resolvedAt: now },
          commands: [
            { type: "UPDATE_MUTE_LIST", peer: event.peer, action: "add" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: now } },
            { type: "EMIT", peer: event.peer, stateName: "BLOCKED" },
          ],
        };
      }
      if (event.type === "REMOTE_CANCEL" && event.createdAt > peerState.resolvedAt) {
        return {
          state: { ...peerState, name: "NONE", resolvedAt: event.createdAt },
          commands: [
            { type: "DELETE", peer: event.peer },
            { type: "EMIT", peer: event.peer, stateName: "NONE" },
          ],
        };
      }
      if (event.type === "REMOTE_REQUEST" && event.createdAt > peerState.resolvedAt) {
        return {
          state: { ...peerState, greeting: event.greeting, resolvedAt: event.createdAt },
          commands: [
            { type: "UPSERT", peer: event.peer, fields: { greeting: event.greeting, createdAt: event.createdAt } },
            { type: "EMIT", peer: event.peer, stateName: "INCOMING_PENDING" },
          ],
        };
      }
      break;

    case "CONTACT":
      if (event.type === "USER_REMOVE_CONTACT") {
        return {
          state: { ...peerState, name: "NONE", resolvedAt: now },
          commands: [
            { type: "UPDATE_CONTACTS_LIST", peer: event.peer, action: "remove" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: now } },
            { type: "EMIT", peer: event.peer, stateName: "NONE" },
          ],
        };
      }
      if (event.type === "USER_BLOCK") {
        return {
          state: { ...peerState, name: "BLOCKED", resolvedAt: now },
          commands: [
            { type: "UPDATE_CONTACTS_LIST", peer: event.peer, action: "remove" },
            { type: "UPDATE_MUTE_LIST", peer: event.peer, action: "add" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: now } },
            { type: "EMIT", peer: event.peer, stateName: "BLOCKED" },
          ],
        };
      }
      break;

    case "REJECTED_BY_ME":
      if (event.type === "REMOTE_REQUEST" && event.createdAt > peerState.resolvedAt) {
        return {
          state: { ...peerState, name: "INCOMING_PENDING", greeting: event.greeting, resolvedAt: peerState.resolvedAt },
          commands: [
            { type: "UPSERT", peer: event.peer, fields: { greeting: event.greeting, createdAt: event.createdAt } },
            { type: "EMIT", peer: event.peer, stateName: "INCOMING_PENDING" },
          ],
        };
      }
      if (event.type === "USER_SEND_REQUEST") {
        return {
          state: { ...peerState, name: "OUTGOING_PENDING" },
          commands: [
            { type: "PUBLISH_REQUEST", peer: event.peer, greeting: event.greeting },
            { type: "UPSERT", peer: event.peer, fields: {} },
            { type: "EMIT", peer: event.peer, stateName: "OUTGOING_PENDING" },
          ],
        };
      }
      if (event.type === "USER_BLOCK") {
        return {
          state: { ...peerState, name: "BLOCKED", resolvedAt: now },
          commands: [
            { type: "PUBLISH_CANCEL", peer: event.peer },
            { type: "UPDATE_MUTE_LIST", peer: event.peer, action: "add" },
            { type: "UPSERT", peer: event.peer, fields: { resolvedAt: now } },
            { type: "EMIT", peer: event.peer, stateName: "BLOCKED" },
          ],
        };
      }
      break;

    case "BLOCKED":
      if (event.type === "USER_UNBLOCK") {
        return {
          state: { ...peerState, name: "NONE" },
          commands: [
            { type: "UPDATE_MUTE_LIST", peer: event.peer, action: "remove" },
            { type: "EMIT", peer: event.peer, stateName: "NONE" },
          ],
        };
      }
      break;

    default:
      return { state: peerState, commands: [] };
  }

  return { state: peerState, commands: [] };
}

export function reconcileList(relationships, listKind, pubkeySet, createdAt) {
  const targetState = listKind === "contacts" ? "CONTACT" : "BLOCKED";
  const newRelationships = new Map(relationships);
  const commands = [];

  for (const peer of pubkeySet) {
    const existing = newRelationships.get(peer);
    if (!existing || existing.name !== targetState) {
      newRelationships.set(peer, {
        name: targetState,
        peerPubkey: peer,
        resolvedAt: createdAt,
        greeting: null,
      });
      commands.push({ type: "UPSERT", peer, fields: { resolvedAt: createdAt } });
    }
  }

  for (const [peer, peerState] of relationships) {
    if (peerState.name === targetState && !pubkeySet.has(peer)) {
      if (peerState.resolvedAt <= createdAt) {
        newRelationships.set(peer, { ...peerState, name: "NONE", resolvedAt: createdAt });
        commands.push({ type: "DELETE", peer });
      }
    }
  }

  return { relationships: newRelationships, commands };
}
