import type { Actor, JsonObject } from '@framework/core';
import { doublePrecision, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Recorded observations. Export it from your schema so Drizzle Kit generates its migration. */
export const observatoryEntries = pgTable(
  'observatory_entries',
  {
    id: uuid('id').primaryKey(),
    watcher: text('watcher').notNull(),
    summary: text('summary').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    durationMs: doublePrecision('duration_ms'),
    status: text('status').notNull(),
    actor: jsonb('actor').$type<Actor>().notNull(),
    correlationId: text('correlation_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('observatory_entries_occurred_at_idx').on(table.occurredAt),
    index('observatory_entries_watcher_idx').on(table.watcher, table.occurredAt),
  ],
);
