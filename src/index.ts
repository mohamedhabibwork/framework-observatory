// Public API of @framework/observatory.
// Convention: every interface/type lives in `./types`, every constant in
// `./constants`; runtime values (stores, watchers, routes, provider) stay in their modules.
export { OBSERVATORY } from './constants';
export type {
  Observatory,
  ObservatoryCapabilities,
  ObservatoryEntry,
  ObservatoryQuery,
  ObservatoryStore,
  Watcher,
  WatcherName,
} from './types';
