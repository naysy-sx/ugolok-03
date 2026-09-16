import { transition } from '../../core/fsm/machine.js';

// Этап 1 (MESSAGE-DELIVERY-TZ.md, З1.2) — 'queued': строка уже в ленте
// (пользователь нажал "Отправить"), но MLS-группа с собеседником ещё не
// установлена (не-коммиттер ждёт Welcome, см. chat.js/ensureChatEstablished
// И3/И4). ESTABLISHED — момент, когда drainPendingOutgoingMessages реально
// начинает шифровать и публиковать это сообщение.
export const MESSAGE_TRANSITIONS = {
  queued: { ESTABLISHED: 'sending' },
  created: { SEND: 'sending' },
  sending: { ACK: 'sent', FAIL: 'failed' },
  sent: { READ: 'read' },
  failed: { RETRY: 'sending', DISCARD: 'discarded' }
};

export function transitionMessage(state, event) {
  return transition(MESSAGE_TRANSITIONS, state, event);
}
