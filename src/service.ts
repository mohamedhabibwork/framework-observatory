import { currentExecution, type JsonObject, redact, redactUrl } from '@framework/core';
import type {
  Observatory,
  ObservatoryEntry,
  ObservatoryQuery,
  ObservatoryStore,
  RecordOptions,
  WatcherName,
} from './types';

const MAX_SUMMARY_CHARS = 500;
const MAX_PAYLOAD_BYTES = 16 * 1024;
/** Low, because on the shared pool these writes queue ahead of the app's own queries. */
const MAX_PENDING_WRITES = 100;
const MS_PER_HOUR = 3_600_000;
const PRUNE_INTERVAL_MS = MS_PER_HOUR;
const FLUSH_DEADLINE_MS = 5_000;
/** Longer than what's kept, so a credential cut off at the end can't escape the mask. */
const MAX_SUMMARY_INPUT_CHARS = 2_000;

/** Measured before masking: the masking regex is slow on long text. */
function safePayload(payload: JsonObject): JsonObject {
  const bytes = JSON.stringify(payload).length;
  return bytes > MAX_PAYLOAD_BYTES ? { truncated: true, bytes } : redact(payload);
}

/**
 * Records observations without ever failing or slowing the work it watches: writes
 * run in the background, a failed one is dropped, and past a limit new entries are
 * dropped too. Every entry passes through here, so secret-looking keys and URL
 * credentials are masked wherever it came from.
 */
export class ObservatoryService implements Observatory {
  readonly enabled = true;
  readonly #pending = new Set<Promise<void>>();
  #lastPrunedAt = 0;

  constructor(
    private readonly store: ObservatoryStore,
    private readonly retentionHours: number,
  ) {}

  async record(entry: Omit<ObservatoryEntry, 'id'>): Promise<void> {
    if (this.#pending.size >= MAX_PENDING_WRITES) return;
    this.#pruneIfDue();
    const write = this.#write(entry).finally(() => {
      this.#pending.delete(write);
    });
    this.#pending.add(write);
  }

  async recordNow(
    watcher: WatcherName,
    summary: string,
    payload: JsonObject,
    options: RecordOptions = {},
  ): Promise<void> {
    const execution = options.execution ?? currentExecution();
    await this.record({
      watcher,
      summary,
      payload,
      durationMs: options.durationMs ?? null,
      status: options.status ?? 'ok',
      actor: execution.actor,
      correlationId: execution.correlationId,
      occurredAt: new Date().toISOString(),
    });
  }

  /** Keeps the table to its retention window. Every process does this, which is harmless. */
  #pruneIfDue(): void {
    if (Date.now() - this.#lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.#lastPrunedAt = Date.now();
    const pruning: Promise<void> = this.prune()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#pending.delete(pruning);
      });
    this.#pending.add(pruning);
  }

  async #write(entry: Omit<ObservatoryEntry, 'id'>): Promise<void> {
    try {
      await this.store.write({
        ...entry,
        id: crypto.randomUUID(),
        summary: redactUrl(entry.summary.slice(0, MAX_SUMMARY_INPUT_CHARS)).slice(0, MAX_SUMMARY_CHARS),
        payload: safePayload(entry.payload),
      });
    } catch {
      // Losing an observation is fine; failing the request it describes is not.
    }
  }

  /** Waits for queued entries, up to a deadline so a stalled store can't hang shutdown. */
  async flush(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FLUSH_DEADLINE_MS);
    });
    await Promise.race([Promise.all(this.#pending), deadline]);
    clearTimeout(timer);
  }

  query(filter: ObservatoryQuery): Promise<readonly ObservatoryEntry[]> {
    return this.store.query(filter);
  }

  find(id: string): Promise<ObservatoryEntry | null> {
    return this.store.find(id);
  }

  prune(before: Date = new Date(Date.now() - this.retentionHours * MS_PER_HOUR)): Promise<number> {
    return this.store.prune(before);
  }

  clear(): Promise<void> {
    return this.store.clear();
  }
}

/** What's bound while the observatory is off: nothing is kept. */
export const DISABLED_OBSERVATORY: Observatory = {
  enabled: false,
  record: async () => {},
  recordNow: async () => {},
  flush: async () => {},
  query: async () => [],
  find: async () => null,
  prune: async () => 0,
  clear: async () => {},
};
