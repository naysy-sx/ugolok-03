export function transition(transitions, state, event) {
  const nextState = transitions[state]?.[event] ?? transitions["*"]?.[event];

  if (nextState === undefined) {
    throw new Error(`No transition defined for event "${event}" in state "${state}"`);
  }

  return nextState;
}
