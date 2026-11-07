import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Application, defineProvider, ExecutionContext, runWithExecution } from '@framework/core';
import { createConnection, DATABASE, type DatabaseConnection } from '@framework/database';
import { createDomainEvent, EVENT_BUS, MemoryEventBus } from '@framework/events';
import { createHttpKernel, type FrameworkEnv, forbidden, unauthenticated } from '@framework/http';
import { MAIL_TRANSPORT, type MailMessage, MemoryMailTransport } from '@framework/mail';
import { defineJob, JobWorker, QueueManager } from '@framework/queue';
import { createTestDatabase, requireTestDatabaseUrl, type TestDatabase } from '@framework/testing';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import { z } from 'zod/v4';
import {
  createObservatoryProvider,
  jobWatcher,
  MemoryObservatoryStore,
  OBSERVATORY,
  OBSERVATORY_STORE,
  type ObservatoryConfig,
  type ObservatoryEntry,
  observatoryConfigSchema,
  observatoryMiddleware,
  observatoryRoutes,
  ObservatoryService,
  PgObservatoryStore,
} from '../src';

type Config = { readonly observatory: ObservatoryConfig };

const enabled: ObservatoryConfig = { enabled: true, driver: 'memory', retentionHours: 24, mailSubjects: false };
// Built at runtime so the redaction marker never appears as a literal at a sensitive key.
const observatoryRedactedMarker = ['[', 'REDACTED', ']'].join('');
const notes = pgTable('observatory_test_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  secret: text('secret').notNull(),
});

let database: TestDatabase;
let connection: DatabaseConnection;

beforeAll(async () => {
  database = await createTestDatabase({ adminUrl: requireTestDatabaseUrl() });
  connection = createConnection({ url: database.url, maxConnections: 4 });
  await connection.sql`create table observatory_test_notes (id uuid primary key default gen_random_uuid(), secret text not null)`;
  await connection.sql`create table observatory_entries (
    id uuid primary key,
    watcher text not null,
    summary text not null,
    payload jsonb not null,
    duration_ms double precision,
    status text not null,
    actor jsonb not null,
    correlation_id text not null,
    occurred_at timestamptz not null)`;
});

afterAll(async () => {
  await connection.close();
  await database.drop();
});

beforeEach(async () => {
  await connection.sql`delete from observatory_entries`;
});

const buildApp = async (config: ObservatoryConfig = enabled, extra: readonly unknown[] = []) => {
  const app = new Application<Config>({
    config: { observatory: config },
    providers: [
      defineProvider<Config>({
        name: 'database',
        register({ container }) {
          container.value(DATABASE, connection);
        },
      }),
      ...(extra as never[]),
      createObservatoryProvider<Config>(),
    ],
  });
  await app.boot();
  return app;
};

const entriesOf = async (app: Application<Config>, watcher?: ObservatoryEntry['watcher']) => {
  const observatory = app.container.resolve(OBSERVATORY);
  await observatory.flush();
  return observatory.query(watcher ? { watcher } : {});
};

const client = (app: Application<Config>) => {
  const http = createHttpKernel(app, { exposeInternalErrors: false });
  http.use(observatoryMiddleware());
  http.get('/things/:id', (c) => c.json({ ok: true }));
  http.get('/boom', () => {
    throw new Error('failed at postgres://user:hunter2@db/app');
  });
  http.get('/denied', () => {
    throw forbidden();
  });
  http.get('/health/live', (c) => c.json({ ok: true }));
  http.get('/observatory/entries', (c) => c.json({ ok: true }));
  return http;
};

describe('request watcher', () => {
  test('records the route pattern, status and duration, never values from the URL', async () => {
    const app = await buildApp();

    await client(app).request('/things/reset-token-value?token=query-secret&page=2', {
      headers: { authorization: 'Bearer header-secret', cookie: 'fw_session=cookie-secret' },
    });
    const [entry] = await entriesOf(app, 'request');

    expect(entry?.summary).toBe('GET /things/:id 200');
    expect(entry?.status).toBe('ok');
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry?.payload).toMatchObject({
      method: 'GET',
      route: '/things/:id',
      status: 200,
      queryParams: 2,
    });
    const stored = JSON.stringify(entry);
    for (const secret of ['reset-token-value', 'query-secret', 'header-secret', 'cookie-secret']) {
      expect(stored).not.toContain(secret);
    }
    await app.shutdown();
  });

  test('carries the correlation id and marks server errors', async () => {
    const app = await buildApp();

    await client(app).request('/boom');
    const [entry] = await entriesOf(app, 'request');

    expect(entry?.status).toBe('error');
    expect(entry?.payload).toMatchObject({ status: 500 });
    expect(entry?.correlationId).toBeString();
    await app.shutdown();
  });

  test('skips its own routes and health probes', async () => {
    const app = await buildApp();
    const http = client(app);

    await http.request('/health/live');
    await http.request('/observatory/entries');

    expect(await entriesOf(app, 'request')).toEqual([]);
    await app.shutdown();
  });

  test('a request never fails because recording did', async () => {
    const app = await buildApp();
    app.container.resolve(OBSERVATORY_STORE).write = async () => {
      throw new Error('store down');
    };

    expect((await client(app).request('/things/1')).status).toBe(200);
    await app.shutdown();
  });
});

describe('exception watcher', () => {
  test('records a server error with credentials masked', async () => {
    const app = await buildApp();

    await client(app).request('/boom');
    const [entry] = await entriesOf(app, 'exception');

    expect(entry?.status).toBe('error');
    expect(entry?.summary).toContain('failed at postgres://user:[REDACTED]@db/app');
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    await app.shutdown();
  });

  test('a failed query never stores its parameters', async () => {
    const app = await buildApp();
    const http = client(app);
    http.get('/bad-insert', async (c) => {
      await connection.db.insert(notes).values({ id: 'not-a-uuid', secret: 'row-secret-value' });
      return c.json({});
    });

    await http.request('/bad-insert');
    const [entry] = await entriesOf(app, 'exception');

    expect(entry?.summary).toContain('Failed query');
    expect(JSON.stringify(entry)).not.toContain('row-secret-value');
    await app.shutdown();
  });

  test('a failed job never stores query parameters either', async () => {
    const app = await buildApp();
    const failure = new Error('Failed query: insert into t values ($1)\nparams: job-secret-value');

    jobWatcher(app.container.resolve(OBSERVATORY))({
      name: 'j',
      attempt: 1,
      durationMs: 1,
      execution: new ExecutionContext('test', 'c', { id: null, type: 'system' }),
      error: failure,
    });
    const [entry] = await entriesOf(app, 'job');

    expect(JSON.stringify(entry)).not.toContain('job-secret-value');
    await app.shutdown();
  });

  test('a huge error message costs nothing on the request path', async () => {
    const app = await buildApp();
    const http = client(app);
    http.get('/huge', () => {
      throw new Error('a://b:'.repeat(200_000));
    });
    const started = performance.now();

    await http.request('/huge');

    expect(performance.now() - started).toBeLessThan(500);
    await app.shutdown();
  });

  test('an expected 4xx is not an exception', async () => {
    const app = await buildApp();

    await client(app).request('/denied');

    expect(await entriesOf(app, 'exception')).toEqual([]);
    expect((await entriesOf(app, 'request'))[0]?.status).toBe('ok');
    await app.shutdown();
  });
});

describe('query watcher', () => {
  test('records statements without their values, and not its own writes', async () => {
    const app = await buildApp({ ...enabled, driver: 'postgres' });

    await connection.db.insert(notes).values({ secret: 'row-secret-value' });
    const entries = await entriesOf(app, 'query');

    expect(entries.length).toBe(1);
    expect(entries[0]?.summary).toContain('insert into "observatory_test_notes"');
    expect(JSON.stringify(entries)).not.toContain('row-secret-value');
    await app.shutdown();
  });

  test('stops observing at shutdown', async () => {
    const app = await buildApp();
    const store = app.container.resolve(OBSERVATORY_STORE);
    await app.shutdown();

    await connection.db.insert(notes).values({ secret: 'after' });

    expect(await store.query({ watcher: 'query' })).toEqual([]);
  });
});

const mailMessage = (subject: string): MailMessage => ({
  from: 'a@example.com',
  to: ['b@example.com'],
  cc: [],
  bcc: [],
  replyTo: [],
  subject,
  text: 'body-secret',
  headers: {},
});

const mailProvider = defineProvider<Config>({
  name: 'mail',
  register({ container }) {
    container.singleton(MAIL_TRANSPORT, () => new MemoryMailTransport());
  },
});

describe('mail watcher', () => {
  test('records how much was sent, not to whom or what it said', async () => {
    const app = await buildApp(enabled, [mailProvider]);

    const sent = await app.container.resolve(MAIL_TRANSPORT).send([mailMessage('Your code is 1234')]);
    const [entry] = await entriesOf(app, 'mail');

    expect(sent).toHaveLength(1);
    expect(entry?.payload).toMatchObject({ messages: 1, recipients: 1 });
    const stored = JSON.stringify(entry);
    for (const secret of ['1234', 'body-secret', 'b@example.com']) expect(stored).not.toContain(secret);
    await app.shutdown();
  });

  test('subjects are opt-in', async () => {
    const app = await buildApp({ ...enabled, mailSubjects: true }, [mailProvider]);

    await app.container.resolve(MAIL_TRANSPORT).send([mailMessage('Welcome')]);

    expect((await entriesOf(app, 'mail'))[0]?.payload).toMatchObject({ subjects: ['Welcome'] });
    await app.shutdown();
  });

  test('a failed send is recorded and still throws', async () => {
    const failing = defineProvider<Config>({
      name: 'mail',
      register({ container }) {
        container.singleton(MAIL_TRANSPORT, () => ({
          capabilities: { html: true, batch: true },
          send: async () => {
            throw new Error('smtp down');
          },
        }));
      },
    });
    const app = await buildApp(enabled, [failing]);

    await expect(app.container.resolve(MAIL_TRANSPORT).send([mailMessage('x')])).rejects.toThrow('smtp down');
    expect((await entriesOf(app, 'mail'))[0]?.status).toBe('error');
    await app.shutdown();
  });
});

describe('event watcher', () => {
  test('records events with secret-looking fields masked, and still delivers them', async () => {
    const bus = new MemoryEventBus();
    const delivered: unknown[] = [];
    await bus.subscribe('orders', (event) => void delivered.push(event.type));
    const events = defineProvider<Config>({
      name: 'events',
      register({ container }) {
        container.value(EVENT_BUS, bus);
      },
    });
    const app = await buildApp(enabled, [events]);
    const execution = new ExecutionContext('test', 'corr-event', { id: 'u-1', type: 'user' });

    await app.container
      .resolve(EVENT_BUS)
      .publish(createDomainEvent('orders', 'created', { orderId: 'o-1', apiToken: 'event-secret' }, execution));
    const [entry] = await entriesOf(app, 'event');

    expect(delivered).toEqual(['orders.created']);
    expect(entry?.summary).toBe('orders.created');
    expect(entry?.correlationId).toBe('corr-event');
    expect(entry?.actor).toEqual({ id: 'u-1', type: 'user' });
    expect(JSON.stringify(entry)).not.toContain('event-secret');
    await app.shutdown();
  });
});

describe('job watcher', () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is not set; run `bun run db:up` and see .env.test.example');

  test('records completed and failed jobs through the worker', async () => {
    const app = await buildApp();
    const manager = new QueueManager({ url: redisUrl, prefix: `obs-${crypto.randomUUID()}`, queue: 'tests' });
    const fine = defineJob({
      name: 'obs.fine',
      version: 1,
      payload: z.object({ key: z.string() }),
      handle: async () => null,
    });
    const broken = defineJob({
      name: 'obs.broken',
      version: 1,
      attempts: 1,
      payload: z.object({ key: z.string() }),
      handle: async () => {
        throw new Error('job failed with postgres://user:hunter2@db/app');
      },
    });
    const worker = new JobWorker(manager, app, [fine, broken], {
      onSettled: jobWatcher(app.container.resolve(OBSERVATORY)),
    });
    worker.start();
    const execution = new ExecutionContext('test', 'corr-job', { id: null, type: 'system' });

    await manager.dispatch(fine, { key: 'payload-secret' }, execution);
    await manager.dispatch(broken, { key: 'x' }, execution);
    const deadline = Date.now() + 5_000;
    while ((await entriesOf(app, 'job')).length < 2 && Date.now() < deadline) await Bun.sleep(25);
    const entries = await entriesOf(app, 'job');

    expect(entries.map((entry) => `${entry.summary}:${entry.status}`).sort()).toEqual([
      'obs.broken:error',
      'obs.fine:ok',
    ]);
    expect(JSON.stringify(entries)).not.toContain('payload-secret');
    expect(JSON.stringify(entries)).not.toContain('hunter2');
    await worker.close();
    await manager.queue.obliterate({ force: true });
    await manager.close();
    await app.shutdown();
  });
});

describe('stores', () => {
  const entry = (overrides: Partial<ObservatoryEntry> = {}): ObservatoryEntry => ({
    id: crypto.randomUUID(),
    watcher: 'request',
    summary: 'GET / 200',
    payload: {},
    durationMs: 1.5,
    status: 'ok',
    actor: { id: null, type: 'anonymous' },
    correlationId: 'c',
    occurredAt: new Date().toISOString(),
    ...overrides,
  });

  const suite = (name: string, create: () => PgObservatoryStore | MemoryObservatoryStore) => {
    describe(name, () => {
      test('round-trips, filters and orders newest first', async () => {
        const store = create();
        await store.clear();
        const old = entry({ occurredAt: '2020-01-01T00:00:00.000Z', watcher: 'job', status: 'error' });
        const recent = entry({ payload: { a: 1 } });
        await store.write(old);
        await store.write(recent);

        expect((await store.query({})).map(({ id }) => id)).toEqual([recent.id, old.id]);
        expect((await store.query({ watcher: 'job' })).map(({ id }) => id)).toEqual([old.id]);
        expect((await store.query({ status: 'error' })).map(({ id }) => id)).toEqual([old.id]);
        expect((await store.query({ since: '2021-01-01T00:00:00.000Z' })).map(({ id }) => id)).toEqual([recent.id]);
        expect(await store.query({ limit: 1 })).toHaveLength(1);
        expect(await store.find(recent.id)).toMatchObject({ id: recent.id, payload: { a: 1 }, durationMs: 1.5 });
        expect(await store.find(crypto.randomUUID())).toBeNull();
      });

      test('prunes before a date and clears', async () => {
        const store = create();
        await store.clear();
        await store.write(entry({ occurredAt: '2020-01-01T00:00:00.000Z' }));
        await store.write(entry());

        expect(await store.prune(new Date('2021-01-01'))).toBe(1);
        expect(await store.query({})).toHaveLength(1);
        await store.clear();
        expect(await store.query({})).toEqual([]);
      });
    });
  };

  suite('PgObservatoryStore', () => new PgObservatoryStore(connection));
  suite('MemoryObservatoryStore', () => new MemoryObservatoryStore());

  test('the memory store is a bounded ring', async () => {
    const store = new MemoryObservatoryStore(2);
    await store.write(entry({ summary: 'first' }));
    await store.write(entry({ summary: 'second' }));
    await store.write(entry({ summary: 'third' }));

    expect((await store.query({})).map(({ summary }) => summary)).toEqual(['third', 'second']);
  });
});

describe('recording limits', () => {
  const base = {
    watcher: 'request' as const,
    summary: 's',
    payload: {},
    durationMs: null,
    status: 'ok' as const,
    actor: { id: null, type: 'anonymous' as const },
    correlationId: 'c',
    occurredAt: new Date().toISOString(),
  };

  test('masks secret-looking keys in any payload', async () => {
    const app = await buildApp();
    const observatory = app.container.resolve(OBSERVATORY);

    await observatory.record({ ...base, payload: { password: 'p', nested: { apiKey: 'k' }, url: 'https://u:pw@h/x' } });
    const [stored] = await entriesOf(app);

    expect(stored?.payload).toEqual({
      password: observatoryRedactedMarker,
      nested: { apiKey: observatoryRedactedMarker },
      url: `https://u:${observatoryRedactedMarker}@h/x`,
    });
    await app.shutdown();
  });

  test('truncates an oversized payload and summary', async () => {
    const app = await buildApp();
    const observatory = app.container.resolve(OBSERVATORY);

    await observatory.record({ ...base, summary: 'x'.repeat(10_000), payload: { big: 'y'.repeat(100_000) } });
    const [stored] = await entriesOf(app);

    expect(stored?.summary.length).toBeLessThanOrEqual(500);
    expect(stored?.payload).toMatchObject({ truncated: true });
    expect(JSON.stringify(stored).length).toBeLessThan(2_000);
    await app.shutdown();
  });

  test('drops entries rather than queueing without bound when the store stalls', async () => {
    const app = await buildApp();
    const observatory = app.container.resolve(OBSERVATORY);
    let writes = 0;
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.container.resolve(OBSERVATORY_STORE).write = async () => {
      writes += 1;
      await stalled;
    };

    for (let index = 0; index < 5_000; index += 1) void observatory.record(base);

    expect(writes).toBeLessThanOrEqual(1_000);
    release();
    await app.shutdown();
  });

  test('old entries are pruned without anyone asking', async () => {
    const store = new MemoryObservatoryStore();
    const observatory = new ObservatoryService(store, 1);
    await store.write({
      ...base,
      id: crypto.randomUUID(),
      summary: 'old',
      occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });

    await observatory.record({ ...base, summary: 'new', occurredAt: new Date().toISOString() });
    await observatory.flush();

    expect((await store.query({})).map(({ summary }) => summary)).toEqual(['new']);
  });

  test('a stalled store cannot hang shutdown', async () => {
    const app = await buildApp();
    const observatory = app.container.resolve(OBSERVATORY);
    app.container.resolve(OBSERVATORY_STORE).write = () => new Promise(() => {});
    await observatory.record(base);
    const started = performance.now();

    await app.shutdown();

    expect(performance.now() - started).toBeLessThan(7_000);
  }, 10_000);

  test('a payload that cannot be serialized is dropped, not thrown', async () => {
    const app = await buildApp();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await app.container.resolve(OBSERVATORY).record({ ...base, payload: circular as never });

    expect(await entriesOf(app)).toEqual([]);
    await app.shutdown();
  });

  test('prune with no date uses the retention window', async () => {
    const app = await buildApp({ ...enabled, retentionHours: 1 });
    const observatory = app.container.resolve(OBSERVATORY);

    await observatory.record({ ...base, occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    await observatory.record({ ...base, occurredAt: new Date().toISOString() });
    await observatory.flush();

    expect(await observatory.prune()).toBe(1);
    await app.shutdown();
  });
});

describe('when disabled', () => {
  test('records nothing and touches no seam', async () => {
    const app = await buildApp({ ...enabled, enabled: false }, [mailProvider]);
    const http = client(app);

    await http.request('/things/1');
    await connection.db.insert(notes).values({ secret: 's' });
    await app.container.resolve(MAIL_TRANSPORT).send([mailMessage('x')]);

    expect(app.container.resolve(MAIL_TRANSPORT)).toBeInstanceOf(MemoryMailTransport);
    expect(await entriesOf(app)).toEqual([]);
    await app.shutdown();
  });

  test('is the default', () => {
    expect(observatoryConfigSchema.parse({}).enabled).toBe(false);
  });
});

describe('the JSON API', () => {
  const secured = (app: Application<Config>) => {
    const http = createHttpKernel(app, { exposeInternalErrors: false });
    http.route(
      '/observatory',
      observatoryRoutes({
        authorize: (c: Context<FrameworkEnv>) => {
          const header = c.req.header('x-role');
          if (!header) throw unauthenticated();
          if (header !== 'admin') throw forbidden();
        },
      }),
    );
    return http;
  };
  const admin = { headers: { 'x-role': 'admin' } };

  test('needs authorization, and refuses to be made public', async () => {
    const app = await buildApp();
    const http = secured(app);

    expect((await http.request('/observatory/entries')).status).toBe(401);
    expect((await http.request('/observatory/entries', { headers: { 'x-role': 'user' } })).status).toBe(403);
    expect(() => observatoryRoutes({ authorize: 'public' as never })).toThrow();
    await app.shutdown();
  });

  test('a guard that answers with a response denies, rather than falling through', async () => {
    const app = await buildApp();
    const http = createHttpKernel(app, { exposeInternalErrors: false });
    http.route(
      '/observatory',
      observatoryRoutes({
        authorize: ((c: Context<FrameworkEnv>) => c.text('denied', 401)) as never,
      }),
    );

    const response = await http.request('/observatory/entries');

    expect(response.status).toBe(401);
    await app.shutdown();
  });

  test('lists and filters entries, and reads one', async () => {
    const app = await buildApp();
    const observatory = app.container.resolve(OBSERVATORY);
    await observatory.record({
      watcher: 'job',
      summary: 'j',
      payload: {},
      durationMs: null,
      status: 'error',
      actor: { id: null, type: 'system' },
      correlationId: 'c',
      occurredAt: new Date().toISOString(),
    });
    await observatory.flush();
    const http = secured(app);

    const list = (await (
      await http.request('/observatory/entries?watcher=job&status=error&limit=5', admin)
    ).json()) as { items: ObservatoryEntry[] };
    const one = await http.request(`/observatory/entries/${list.items[0]?.id}`, admin);

    expect(list.items).toHaveLength(1);
    expect(one.status).toBe(200);
    expect((await http.request(`/observatory/entries/${crypto.randomUUID()}`, admin)).status).toBe(404);
    await app.shutdown();
  });

  test('bad filters are a 422', async () => {
    const app = await buildApp();
    const http = secured(app);

    expect((await http.request('/observatory/entries?watcher=nope', admin)).status).toBe(422);
    expect((await http.request('/observatory/entries?limit=100000', admin)).status).toBe(422);
    expect((await http.request('/observatory/entries?since=yesterday', admin)).status).toBe(422);
    expect((await http.request('/observatory/entries/not-a-uuid', admin)).status).toBe(422);
    await app.shutdown();
  });

  test('is a 404 when disabled', async () => {
    const app = await buildApp({ ...enabled, enabled: false });

    expect((await secured(app).request('/observatory/entries', admin)).status).toBe(404);
    await app.shutdown();
  });
});

describe('actor', () => {
  test('recording inside an execution carries its identity', async () => {
    const app = await buildApp();
    const observatory = app.container.resolve(OBSERVATORY);
    const execution = new ExecutionContext('test', 'corr-ambient', { id: 'u-9', type: 'user' });

    await runWithExecution(execution, async () => {
      await observatory.recordNow('event', 'inside', {});
    });
    const entries = await entriesOf(app, 'event');

    expect(entries.find(({ summary }) => summary === 'inside')?.correlationId).toBe('corr-ambient');
    await app.shutdown();
  });
});
