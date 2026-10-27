/**
 * Every interface and type of `@framework/observatory` (the Telescope equivalent).
 * Type-only: importing from this module never emits runtime code.
 *
 * Observatory is **in-app, per-request, dev-time inspection** (Laravel Telescope
 * semantics), distinct from the planned OpenTelemetry tracing work (ADR-20). It
 * records into a local `ObservatoryStore` and never exports spans. Watchers are
 * observers wired into existing seams; they are never public (ADR-8).
 */
import type { Actor, JsonObject } from '@framework/core';

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
  prune(before: Date): Promise<number>;
  clear(): Promise<void>;
}

/** Observes one seam and records entries. */
export interface Watcher {
  readonly name: WatcherName;
  record(entry: Omit<ObservatoryEntry, 'id' | 'watcher'>): Promise<void>;
}

/** The observability service: record/query/prune over the active store. */
export interface Observatory {
  record(entry: Omit<ObservatoryEntry, 'id'>): Promise<void>;
  query(filter: ObservatoryQuery): Promise<readonly ObservatoryEntry[]>;
  prune(before?: Date): Promise<number>;
}
