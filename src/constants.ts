/** Constants of `@framework/observatory`: DI tokens and fixed defaults. */
import { token } from '@framework/core';
import type { Observatory, ObservatoryStore } from './types';

/** The observability service (record/query/prune over the active store). */
export const OBSERVATORY = token<Observatory>('observatory');

/** Where entries are kept. Only bound while the observatory is enabled. */
export const OBSERVATORY_STORE = token<ObservatoryStore>('observatory.store');
