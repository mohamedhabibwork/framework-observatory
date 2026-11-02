import type { DatabaseConnection } from '@framework/database';
import { and, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
import { observatoryEntries } from './schema';
import type { ObservatoryCapabilities, ObservatoryEntry, ObservatoryQuery, ObservatoryStore } from './types';

const DEFAULT_QUERY_LIMIT = 100;
const DEFAULT_MEMORY_ENTRIES = 1_000;

const newestFirst = (a: ObservatoryEntry, b: ObservatoryEntry): number => b.occurredAt.localeCompare(a.occurredAt);

/** Entries in `observatory_entries`, shared by every process. */
export class PgObservatoryStore implements ObservatoryStore {
  readonly capabilities: ObservatoryCapabilities = { query: true, prune: true };

  constructor(private readonly connection: DatabaseConnection) {}

  async write(entry: ObservatoryEntry): Promise<void> {
    await this.connection.db.insert(observatoryEntries).values(entry);
  }

  async query(filter: ObservatoryQuery): Promise<readonly ObservatoryEntry[]> {
    const conditions: SQL[] = [
      ...(filter.watcher ? [eq(observatoryEntries.watcher, filter.watcher)] : []),
      ...(filter.status ? [eq(observatoryEntries.status, filter.status)] : []),
      ...(filter.since ? [gte(observatoryEntries.occurredAt, filter.since)] : []),
    ];
    const rows = await this.connection.db
      .select()
      .from(observatoryEntries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(observatoryEntries.occurredAt))
      .limit(filter.limit ?? DEFAULT_QUERY_LIMIT);
    return rows as ObservatoryEntry[];
  }

  async find(id: string): Promise<ObservatoryEntry | null> {
    const rows = await this.connection.db
      .select()
      .from(observatoryEntries)
      .where(eq(observatoryEntries.id, id))
      .limit(1);
    return (rows[0] as ObservatoryEntry | undefined) ?? null;
  }

  async prune(before: Date): Promise<number> {
    const removed = await this.connection.db
      .delete(observatoryEntries)
      .where(lt(observatoryEntries.occurredAt, before.toISOString()))
      .returning({ id: observatoryEntries.id });
    return removed.length;
  }

  async clear(): Promise<void> {
    await this.connection.db.delete(observatoryEntries);
  }
}

/** A bounded ring in this process, for development and tests. */
export class MemoryObservatoryStore implements ObservatoryStore {
  readonly capabilities: ObservatoryCapabilities = { query: true, prune: true };
  #entries: readonly ObservatoryEntry[] = [];

  constructor(private readonly maxEntries: number = DEFAULT_MEMORY_ENTRIES) {}

  async write(entry: ObservatoryEntry): Promise<void> {
    this.#entries = [...this.#entries.slice(Math.max(0, this.#entries.length - this.maxEntries + 1)), entry];
  }

  async query(filter: ObservatoryQuery): Promise<readonly ObservatoryEntry[]> {
    // Reversed first: entries in the same millisecond still come back newest first.
    return this.#entries
      .toReversed()
      .filter(
        (entry) =>
          (!filter.watcher || entry.watcher === filter.watcher) &&
          (!filter.status || entry.status === filter.status) &&
          (!filter.since || Date.parse(entry.occurredAt) >= Date.parse(filter.since)),
      )
      .toSorted(newestFirst)
      .slice(0, filter.limit ?? DEFAULT_QUERY_LIMIT);
  }

  async find(id: string): Promise<ObservatoryEntry | null> {
    return this.#entries.find((entry) => entry.id === id) ?? null;
  }

  async prune(before: Date): Promise<number> {
    const kept = this.#entries.filter((entry) => Date.parse(entry.occurredAt) >= before.getTime());
    const removed = this.#entries.length - kept.length;
    this.#entries = kept;
    return removed;
  }

  async clear(): Promise<void> {
    this.#entries = [];
  }
}
