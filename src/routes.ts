import { FrameworkError } from '@framework/core';
import { authorizationGuard, type FrameworkEnv, type MountAuthorization, notFound, resolve } from '@framework/http';
import { validate } from '@framework/validation';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod/v4';
import { OBSERVATORY } from './constants';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const querySchema = z
  .object({
    watcher: z.enum(['request', 'query', 'job', 'event', 'exception', 'mail', 'cache']).optional(),
    status: z.enum(['ok', 'error']).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

const idSchema = z.object({ id: z.guid() }).strict();

export interface ObservatoryRoutesOptions {
  /** Required, and can't be `'public'`: entries describe your traffic and internals. */
  readonly authorize: Exclude<MountAuthorization, 'public'>;
}

/**
 * The JSON API, mounted by the application:
 *
 * ```text
 * GET /entries?watcher=&status=&since=&limit=   newest first
 * GET /entries/:id
 * ```
 *
 * Everything is a 404 while the observatory is disabled.
 */
export function observatoryRoutes(options: ObservatoryRoutesOptions): Hono<FrameworkEnv> {
  if ((options.authorize as MountAuthorization) === 'public') {
    throw new FrameworkError('OBSERVATORY_PUBLIC', 'observatoryRoutes must have an authorize guard');
  }
  const guard = authorizationGuard(options.authorize);
  const available: MiddlewareHandler<FrameworkEnv> = async (c, next) => {
    if (!resolve(c, OBSERVATORY).enabled) throw notFound('Not found');
    await next();
  };
  return new Hono<FrameworkEnv>()
    .get('/entries', guard, available, validate('query', querySchema), async (c) => {
      const items = await resolve(c, OBSERVATORY).query(c.req.valid('query'));
      return c.json({ items }, 200);
    })
    .get('/entries/:id', guard, available, validate('param', idSchema), async (c) => {
      const entry = await resolve(c, OBSERVATORY).find(c.req.valid('param').id);
      if (!entry) throw notFound('Unknown entry');
      return c.json(entry, 200);
    });
}
