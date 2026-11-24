/** Shared bounded admission, before authentication. No identity or tenant authority. */
export interface AiAdmissionClock { now(): number; after(ms: number, callback: () => void): () => void; }
export type AiAdmissionFailure = "CAPACITY" | "CANCELLED" | "EXPIRED" | "CLOSED";
export interface AiAdmissionPermit { readonly id: symbol; }
interface Waiting { signal: AbortSignal; deadline: number; resolve(p: AiAdmissionPermit): void; reject(e: Error): void; dispose(): void; }
export class BoundedAiAdmission {
  #active = 0; #queue: Waiting[] = []; #closed = false; #permits = new WeakSet<object>();
  constructor(private readonly clock: AiAdmissionClock, private readonly concurrency: number, private readonly depth: number,
    private readonly waitMs: number, private readonly error: (kind: AiAdmissionFailure) => Error) {
    if (![concurrency, depth, waitMs].every(Number.isSafeInteger) || concurrency < 1 || depth < 0 || waitMs < 1) throw new Error("Invalid admission policy");
  }
  get active(): number { return this.#active; }
  get queued(): number { return this.#queue.length; }
  get hasCapacity(): boolean { return !this.#closed && (this.#active < this.concurrency || this.#queue.length < this.depth); }
  private permit(): AiAdmissionPermit { const p = Object.freeze({ id: Symbol() }); this.#permits.add(p); this.#active++; return p; }
  acquire(deadline: number, signal: AbortSignal): Promise<AiAdmissionPermit> {
    if (!this.hasCapacity) return Promise.reject(this.error("CAPACITY"));
    if (signal.aborted || this.clock.now() >= deadline) return Promise.reject(this.error("EXPIRED"));
    if (this.#active < this.concurrency && this.#queue.length === 0) return Promise.resolve(this.permit());
    return new Promise((resolve, reject) => {
      let item: Waiting;
      const remove = () => { this.#queue = this.#queue.filter(w => w !== item); };
      const abort = () => { remove(); item.dispose(); reject(this.error("CANCELLED")); };
      const cancel = this.clock.after(Math.min(this.waitMs, deadline - this.clock.now()), () => { remove(); item.dispose(); reject(this.error("EXPIRED")); });
      item = { signal, deadline, resolve, reject, dispose: () => { cancel(); signal.removeEventListener("abort", abort); } };
      signal.addEventListener("abort", abort, { once: true }); this.#queue.push(item);
    });
  }
  release(permit: AiAdmissionPermit): void {
    if (!this.#permits.delete(permit)) throw new Error("Admission permit rejected");
    this.#active--;
    while (!this.#closed && this.#active < this.concurrency && this.#queue.length) {
      const item = this.#queue.shift()!; item.dispose();
      if (item.signal.aborted || this.clock.now() >= item.deadline) item.reject(this.error("EXPIRED"));
      else item.resolve(this.permit());
    }
  }
  close(): void { this.#closed = true; for (const item of this.#queue.splice(0)) { item.dispose(); item.reject(this.error("CLOSED")); } }
}
