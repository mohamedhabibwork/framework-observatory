/**
 * Every interface and type of `@framework/observatory` (the Telescope equivalent).
 * Type-only: importing from this module never emits runtime code.
 *
 * Observatory is **in-app, per-request, dev-time inspection** (Laravel Telescope
 * semantics), distinct from the planned OpenTelemetry tracing work (ADR-20). It
 * records into a local `ObservatoryStore` and never exports spans. Watchers are
 * observers wired into existing seams; they are never public (ADR-8).
 */
import type { Actor, ExecutionContext, JsonObject } from '@framework/core';

/** The record kinds a watcher produces. */
export type WatcherName = 'request' | 'query' | 'job' | 'event' | 'exception' | 'mail' | 'cache';

/** One recorded observation. */
export interface ObservatoryEntry {
  readonly id: string;
  readonly watcher: WatcherName;
  readonly summary: string;
  readonly payload: JsonObject;
  readonly durationMs: number | null;
  readonly status: 'ok' | 'error';
  readonly actor: Actor;
  readonly correlationId: string;
  /** ISO-8601 timestamp. */
  readonly occurredAt: string;
}

/** Filter for `query`. */
export interface ObservatoryQuery {
  readonly watcher?: WatcherName;
  readonly status?: 'ok' | 'error';
  /** ISO-8601 lower bound (inclusive). */
  readonly since?: string;
  readonly limit?: number;
}

/** Honest capability report for an observability store (ADR-11). */
export interface ObservatoryCapabilities {
  readonly query: boolean;
  readonly prune: boolean;
}

/** Persistence for observations (bounded memory ring buffer in dev/test, Postgres otherwise). */
export interface ObservatoryStore {
  readonly capabilities: ObservatoryCapabilities;
  write(entry: ObservatoryEntry): Promise<void>;
  query(filter: ObservatoryQuery): Promise<readonly ObservatoryEntry[]>;
  find(id: string): Promise<ObservatoryEntry | null>;
  prune(before: Date): Promise<number>;
  clear(): Promise<void>;
}

/** Observes one seam and records entries. */
export interface Watcher {
  readonly name: WatcherName;
  record(entry: Omit<ObservatoryEntry, 'id' | 'watcher'>): Promise<void>;
}

/** How `recordNow` fills in what the caller leaves out. */
export interface RecordOptions {
  readonly durationMs?: number;
  readonly status?: 'ok' | 'error';
  /** Who and which request; defaults to the current execution. */
  readonly execution?: ExecutionContext;
}

/** The observability service: record/query/prune over the active store. */
export interface Observatory {
  /** False while the observatory is off, when everything here is a no-op. */
  readonly enabled: boolean;
  /** Queues the entry and returns; a failure to store it is dropped. */
  record(entry: Omit<ObservatoryEntry, 'id'>): Promise<void>;
  recordNow(watcher: WatcherName, summary: string, payload: JsonObject, options?: RecordOptions): Promise<void>;
  /** Waits for queued entries to be stored. */
  flush(): Promise<void>;
  query(filter: ObservatoryQuery): Promise<readonly ObservatoryEntry[]>;
  find(id: string): Promise<ObservatoryEntry | null>;
  /** Removes entries before `before`, which defaults to the retention window. */
  prune(before?: Date): Promise<number>;
  clear(): Promise<void>;
}

/** Validated `observatory` config section. */
export interface ObservatoryConfig {
  readonly enabled: boolean;
  readonly driver: 'postgres' | 'memory';
  readonly retentionHours: number;
  /** Mail subjects can hold codes and names, so they're left out unless this is on. */
  readonly mailSubjects: boolean;
}
