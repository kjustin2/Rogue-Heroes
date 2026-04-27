export function createRng(seed) {
  let state = seed | 0;
  return {
    next() {
      state = (state + 0x6D2B79F5) | 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    },
    int(min, max) {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
    pick(items) {
      return items[Math.floor(this.next() * items.length)];
    },
    get state() {
      return state | 0;
    },
  };
}
