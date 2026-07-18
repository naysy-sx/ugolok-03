import { transition } from '../../core/fsm/machine.js';

export const MESSAGE_TRANSITIONS = {
  created: { SEND: 'sending' },
  sending: { ACK: 'sent', FAIL: 'failed' },
  sent: { READ: 'read' },
  failed: { RETRY: 'sending', DISCARD: 'discarded' }
};

export function transitionMessage(state, event) {
  return transition(MESSAGE_TRANSITIONS, state, event);
}
