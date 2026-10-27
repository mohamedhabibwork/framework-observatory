/** Constants of `@framework/observatory`: DI tokens and fixed defaults. */
import { token } from '@framework/core';
import type { Observatory } from './types';

/** The observability service (record/query/prune over the active store). */
export const OBSERVATORY = token<Observatory>('observatory');
