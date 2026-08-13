/**
 * Rooms trickle-suppression implementation, RFC 6206
 */

export function createTrickle({ iMin, iMax, k, random }) {
  let c = 0;
  let t = null;
  let intervalEnd = null;
  let I = iMin;
  let firedThisInterval = false;

  return {
    onInterval(now) {
      I = Math.min(2 * I, iMax);
      c = 0;
      t = now + random(I / 2, I);
      intervalEnd = now + I;
      firedThisInterval = false;
    },
    onConsistent() {
      c += 1;
    },
    onInconsistent() {
      I = iMin;
      c = 0;
      // Do not reset t and intervalEnd
      // Caller must call onInterval(now) immediately after onInconsistent()
    },
    shouldTransmit(now) {
      if (t === null) return false;
      if (firedThisInterval) return false;
      if (now < t) return false;
      firedThisInterval = true;
      return c < k;
    }
  };
}
