import { EXECUTION_CONTEXT, redactUrl } from '@framework/core';
import type { DomainEvent, EventBus } from '@framework/events';
import { type FrameworkEnv, HttpError, resolve } from '@framework/http';
import type { MailMessage, MailTransport } from '@framework/mail';
import type { SettledJob } from '@framework/queue';
import { routePath } from 'hono/route';
import { createMiddleware } from 'hono/factory';
import { OBSERVATORY } from './constants';
import type { Observatory } from './types';

const SERVER_ERROR = 500;
const MAX_STACK_CHARS = 4_000;
const MAX_ERROR_CHARS = 1_000;
const DEFAULT_IGNORED_PREFIXES = ['/health', '/observatory'];
const OWN_TABLE = 'observatory_entries';

/**
 * An error's message, safe to store. Only its first line is kept, because a failed
 * Drizzle query appends `params: <bound values>` on the next one. Capped first: the
 * masking regex is slow on long text, and this runs on the request path.
 */
const errorSummary = (error: Error): string =>
  redactUrl((error.message.split('\n', 1)[0] ?? '').slice(0, MAX_ERROR_CHARS));

/** Only a stack's frames: its first lines repeat the message. */
const stackFrames = (error: Error): string =>
  (error.stack ?? '')
    .slice(0, MAX_STACK_CHARS)
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .join('\n');

export interface ObservatoryMiddlewareOptions {
  /** Path prefixes not to record. Defaults to `/health` and `/observatory`. */
  readonly ignore?: readonly string[];
}

/**
 * Records each request and, separately, each server error. Only the route pattern
 * and how many query parameters there were are kept: paths and query strings can
 * hold tokens, and headers and bodies are never read. Mount it after the kernel, before your routes.
 */
export const observatoryMiddleware = (options: ObservatoryMiddlewareOptions = {}) => {
  const ignored = options.ignore ?? DEFAULT_IGNORED_PREFIXES;
  return createMiddleware<FrameworkEnv>(async (c, next) => {
    const observatory = resolve(c, OBSERVATORY);
    if (!observatory.enabled || ignored.some((prefix) => c.req.path.startsWith(prefix))) {
      await next();
      return;
    }
    const startedAt = performance.now();
    await next();
    const durationMs = performance.now() - startedAt;
    const execution = resolve(c, EXECUTION_CONTEXT);
    const status = c.res.status;
    const failed = status >= SERVER_ERROR;
    const route = routePath(c, -1);
    void observatory.recordNow(
      'request',
      `${c.req.method} ${route} ${status}`,
      {
        method: c.req.method,
        route,
        status,
        queryParams: Object.keys(c.req.query()).length,
      },
      { durationMs, status: failed ? 'error' : 'ok', execution },
    );
    const error = c.error;
    if (error && !(error instanceof HttpError && error.status < SERVER_ERROR)) {
      void observatory.recordNow(
        'exception',
        `${error.name}: ${errorSummary(error)}`,
        { name: error.name, route, stack: stackFrames(error) },
        { status: 'error', execution },
      );
    }
  });
};

/** For `JobWorker`'s or `runWorker`'s `onSettled`. Payloads aren't recorded. */
export const jobWatcher =
  (observatory: Observatory) =>
  (job: SettledJob): void => {
    void observatory.recordNow(
      'job',
      job.name,
      { name: job.name, attempt: job.attempt, ...(job.error ? { error: errorSummary(job.error) } : {}) },
      { durationMs: job.durationMs, status: job.error ? 'error' : 'ok', execution: job.execution },
    );
  };

/** Statement text only, as `DatabaseConnection.observeQueries` gives it. Its own writes would never end. */
export const queryWatcher =
  (observatory: Observatory) =>
  (query: string): void => {
    if (query.includes(OWN_TABLE)) return;
    void observatory.recordNow('query', query, {});
  };

const recipientsOf = (messages: readonly MailMessage[]): number =>
  messages.reduce((total, { to, cc, bcc }) => total + to.length + cc.length + bcc.length, 0);

/** Counts what a transport sends. Addresses and bodies are left out, and subjects are opt-in. */
export function watchedTransport(
  transport: MailTransport,
  observatory: Observatory,
  options: { readonly subjects: boolean },
): MailTransport {
  return {
    capabilities: transport.capabilities,
    ...(transport.close ? { close: () => (transport.close as () => Promise<void>)() } : {}),
    async send(messages) {
      const startedAt = performance.now();
      const payload = {
        messages: messages.length,
        recipients: recipientsOf(messages),
        ...(options.subjects ? { subjects: messages.map(({ subject }) => subject) } : {}),
      };
      try {
        const sent = await transport.send(messages);
        void observatory.recordNow('mail', `Sent ${messages.length} message(s)`, payload, {
          durationMs: performance.now() - startedAt,
        });
        return sent;
      } catch (error) {
        void observatory.recordNow('mail', `Failed to send ${messages.length} message(s)`, payload, {
          durationMs: performance.now() - startedAt,
          status: 'error',
        });
        throw error;
      }
    },
  };
}

/** Records each event published. The service masks secret-looking payload fields. */
export function watchedBus(bus: EventBus, observatory: Observatory): EventBus {
  return {
    subscribe: bus.subscribe.bind(bus),
    close: () => bus.close(),
    async publish(event: DomainEvent) {
      await bus.publish(event);
      void observatory.record({
        watcher: 'event',
        summary: event.type,
        payload: { channel: event.channel, payload: event.payload },
        durationMs: null,
        status: 'ok',
        actor: event.actor,
        correlationId: event.correlationId,
        occurredAt: event.occurredAt,
      });
    },
  };
}
