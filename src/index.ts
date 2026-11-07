// Public API of @framework/observatory.
// Convention: every interface/type lives in `./types`, every constant in
// `./constants`; runtime values (stores, watchers, routes, provider) stay in their modules.
export { OBSERVATORY, OBSERVATORY_STORE } from './constants';
export { createObservatoryProvider, type ObservatoryProviderOptions, observatoryConfigSchema } from './provider';
export { type ObservatoryRoutesOptions, observatoryRoutes } from './routes';
export { observatoryEntries } from './schema';
export { DISABLED_OBSERVATORY, ObservatoryService } from './service';
export { MemoryObservatoryStore, PgObservatoryStore } from './stores';
export type {
  Observatory,
  ObservatoryCapabilities,
  ObservatoryConfig,
  ObservatoryEntry,
  ObservatoryQuery,
  ObservatoryStore,
  RecordOptions,
  Watcher,
  WatcherName,
} from './types';
export {
  jobWatcher,
  type ObservatoryMiddlewareOptions,
  observatoryMiddleware,
  queryWatcher,
  watchedBus,
  watchedTransport,
} from './watchers';
