export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }

  emit(type, payload) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const callback of listeners.slice()) callback(payload);
  }
}

export const events = new EventBus();
