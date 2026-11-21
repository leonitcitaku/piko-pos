// One place for "now", so tests can move the clock.
let offset = 0;
export const now = () => Date.now() + offset;
export const setClockOffset = (ms) => { offset = ms; };
