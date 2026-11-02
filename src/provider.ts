import { defineProvider, type ServiceProvider, type Token } from '@framework/core';
import { DATABASE, type DatabaseConnection } from '@framework/database';
import { EVENT_BUS } from '@framework/events';
import { MAIL_TRANSPORT } from '@framework/mail';
import { z } from 'zod/v4';
import { OBSERVATORY, OBSERVATORY_STORE } from './constants';
import { DISABLED_OBSERVATORY, ObservatoryService } from './service';
import { MemoryObservatoryStore, PgObservatoryStore } from './stores';
import type { ObservatoryConfig } from './types';
import { queryWatcher, watchedBus, watchedTransport } from './watchers';

const DEFAULT_RETENTION_HOURS = 24;

/** Validated shape of the application's `observatory` configuration section. It's off unless turned on. */
export const observatoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  driver: z.enum(['postgres', 'memory']).default('postgres'),
  retentionHours: z.number().positive().default(DEFAULT_RETENTION_HOURS),
  mailSubjects: z.boolean().default(false),
});

export interface ObservatoryProviderOptions {
  /**
   * Connection for the `postgres` store; defaults to `DATABASE`. A small separate pool
   * keeps these writes from queueing ahead of the app's queries. `DATABASE` is what's watched.
   */
  readonly connection?: Token<DatabaseConnection>;
}

/**
 * Registers the observatory and wires the query, mail and event watchers. Add
 * `observatoryMiddleware` for requests and exceptions, and `jobWatcher` on workers.
 * While disabled it binds a no-op and touches nothing else.
 */
export function createObservatoryProvider<TConfig extends { readonly observatory: ObservatoryConfig }>(
  options: ObservatoryProviderOptions = {},
): ServiceProvider<TConfig> {
  const connectionToken = options.connection ?? DATABASE;
  return defineProvider<TConfig>({
    name: 'observatory',
    register({ container, config }) {
      const settings = config.observatory;
      if (!settings.enabled) {
        container.value(OBSERVATORY, DISABLED_OBSERVATORY);
        return;
      }
      container.singleton(OBSERVATORY_STORE, (r) =>
        settings.driver === 'memory'
          ? new MemoryObservatoryStore()
          : new PgObservatoryStore(r.resolve<DatabaseConnection>(connectionToken)),
      );
      let stopObservingQueries: (() => void) | undefined;
      container.singleton(
        OBSERVATORY,
        (r) => {
          const observatory = new ObservatoryService(r.resolve(OBSERVATORY_STORE), settings.retentionHours);
          if (r.has(DATABASE)) stopObservingQueries = r.resolve(DATABASE).observeQueries(queryWatcher(observatory));
          return observatory;
        },
        (observatory) => {
          stopObservingQueries?.();
          return observatory.flush();
        },
      );
      container.extend(MAIL_TRANSPORT, (transport, r) =>
        watchedTransport(transport, r.resolve(OBSERVATORY), { subjects: settings.mailSubjects }),
      );
      container.extend(EVENT_BUS, (bus, r) => watchedBus(bus, r.resolve(OBSERVATORY)));
    },
    boot({ container }) {
      // Resolved here so queries are watched from startup, not from the first request.
      container.resolve(OBSERVATORY);
    },
  });
}
