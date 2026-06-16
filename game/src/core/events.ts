export interface EventMap {
  DAMAGE: { entityId: string; partId: string; amount: number; destroyed: boolean };
  ORDER_QUEUED: { actorId: string; kind: string };
  TURN_START: { turn: number };
  RESOLVE_START: { turn: number };
  LOG: { text: string };
}

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

export class EventBus {
  private handlers = new Map<keyof EventMap, Set<Handler<keyof EventMap>>>();

  on<K extends keyof EventMap>(name: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(fn as Handler<keyof EventMap>);
    return () => set.delete(fn as Handler<keyof EventMap>);
  }

  emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of set) (fn as Handler<K>)(payload);
  }
}
