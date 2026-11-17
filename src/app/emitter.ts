/** A minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (payload: never) => void);
    return () => set.delete(listener as (payload: never) => void);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]) {
    this.listeners.get(event)?.forEach((listener) => (listener as (payload: Events[K]) => void)(payload));
  }
}
