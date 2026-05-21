// Lightweight in-memory fakes for the bindings the API surface depends on.
// Same approach as `egress.test.ts` — we don't need miniflare or full
// integration since the API handlers only talk to KV, D1, and the Anthropic
// proxy in well-isolated places.

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

// ---- KV ----

export function makeKv(): KVNamespace {
  const store = new Map<string, { value: string; metadata?: unknown }>();

  const kv = {
    async get(key: string, type?: "text" | "json") {
      const entry = store.get(key);
      if (!entry) return null;
      if (type === "json") {
        try { return JSON.parse(entry.value); } catch { return null; }
      }
      return entry.value;
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      store.set(key, { value, metadata: options?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();
      const start = cursor ? keys.indexOf(cursor) + 1 : 0;
      const slice = keys.slice(start, start + limit);
      const list_complete = start + limit >= keys.length;
      return {
        keys: slice.map((name) => ({ name, metadata: store.get(name)!.metadata })),
        list_complete,
        cursor: list_complete ? "" : slice[slice.length - 1],
      };
    },
    // Internal helper used in tests for assertions.
    _store: store,
  } as unknown as KVNamespace;

  return kv;
}

// ---- D1 ----
//
// We model just enough of D1 to drive the storage module. Everything is
// SQL-driven through `db.prepare(...).bind(...)` — for tests we hand-roll
// matchers on the SQL string and operate on in-memory tables. Cheap, but
// covers `INSERT OR REPLACE`, `INSERT ... ON CONFLICT`, `SELECT ... WHERE`,
// `DELETE`, and the small COUNT/aggregate calls we actually use.

interface FakeRow {
  [k: string]: unknown;
}

interface FakeTables {
  webhook_events: Map<string, FakeRow>;
  sessions: Map<string, FakeRow>;
  agent_backends: Map<string, FakeRow>;
  inbox: Map<string, FakeRow>;
  agent_emails: Map<string, FakeRow>;
  sent_messages: Map<string, FakeRow>;
  // Keyed by `${agent_id}\x00${counterparty}` since the real primary key is composite.
  email_threads: Map<string, FakeRow>;
}

export function makeDb(): D1Database & { _tables: FakeTables } {
  const tables: FakeTables = {
    webhook_events: new Map(),
    sessions: new Map(),
    agent_backends: new Map(),
    inbox: new Map(),
    agent_emails: new Map(),
    sent_messages: new Map(),
    email_threads: new Map(),
  };

  function exec(sql: string, params: unknown[]): { results: FakeRow[]; meta?: { changes: number } } {
    const trimmed = sql.replace(/\s+/g, " ").trim();

    // INSERT OR REPLACE INTO webhook_events
    if (/^INSERT OR REPLACE INTO webhook_events/i.test(trimmed)) {
      const [id, type, session_id, ts_ms, body] = params as [string, string, string, number, string];
      tables.webhook_events.set(id, { id, type, session_id, ts_ms, body });
      return { results: [], meta: { changes: 1 } };
    }

    // upsertSession — INSERT ... ON CONFLICT for sessions with the
    // last_data_json column. Distinct from recordSessionAgent below,
    // which targets the (agent_id, backend) columns instead. Match the
    // wide column list explicitly so the two callers never trip over
    // each other based on regex ordering.
    if (
      /^INSERT INTO sessions \(session_id, created_at_ms, last_webhook_at_ms, last_webhook_type, last_data_json\) .*ON CONFLICT/i.test(
        trimmed,
      )
    ) {
      const [session_id, ts_ms, last_type, last_data_json] = params as [
        string,
        number,
        string,
        string | null,
      ];
      const existing = tables.sessions.get(session_id);
      if (existing) {
        existing.last_webhook_at_ms = ts_ms;
        existing.last_webhook_type = last_type;
        // Mirror the real SQL's COALESCE(?4, sessions.last_data_json): only
        // update when fresh data is supplied so pings don't wipe the cached
        // payload.
        if (last_data_json != null) existing.last_data_json = last_data_json;
      } else {
        tables.sessions.set(session_id, {
          session_id,
          created_at_ms: ts_ms,
          last_webhook_at_ms: ts_ms,
          last_webhook_type: last_type,
          last_data_json: last_data_json ?? null,
        });
      }
      return { results: [], meta: { changes: 1 } };
    }

    // SELECT * FROM sessions
    if (/^SELECT .* FROM sessions ORDER BY/i.test(trimmed)) {
      const [limit, offset] = params as [number, number];
      const all = Array.from(tables.sessions.values()).sort(
        (a, b) => Number(b.last_webhook_at_ms) - Number(a.last_webhook_at_ms),
      );
      return { results: all.slice(offset, offset + limit) };
    }

    if (/^SELECT COUNT\(\*\) AS c FROM sessions/i.test(trimmed)) {
      return { results: [{ c: tables.sessions.size }] };
    }

    // SELECT * FROM webhook_events WHERE ts_ms < ?
    if (/^SELECT .* FROM webhook_events WHERE ts_ms < \? ORDER BY/i.test(trimmed)) {
      const [before, limit] = params as [number, number];
      const all = Array.from(tables.webhook_events.values())
        .filter((r) => Number(r.ts_ms) < Number(before))
        .sort((a, b) => Number(b.ts_ms) - Number(a.ts_ms));
      return { results: all.slice(0, limit) };
    }

    // SELECT body FROM webhook_events WHERE id = ?
    if (/^SELECT body FROM webhook_events WHERE id = \?/i.test(trimmed)) {
      const [id] = params as [string];
      const row = tables.webhook_events.get(id);
      return { results: row ? [{ body: row.body }] : [] };
    }

    if (/^SELECT COUNT\(\*\) AS c FROM webhook_events/i.test(trimmed)) {
      return { results: [{ c: tables.webhook_events.size }] };
    }

    if (/^DELETE FROM webhook_events WHERE ts_ms < \?/i.test(trimmed)) {
      const [cutoff] = params as [number];
      let changes = 0;
      for (const [id, row] of tables.webhook_events) {
        if (Number(row.ts_ms) < Number(cutoff)) {
          tables.webhook_events.delete(id);
          changes++;
        }
      }
      return { results: [], meta: { changes } };
    }

    if (/^DELETE FROM sessions WHERE last_webhook_at_ms < \?/i.test(trimmed)) {
      const [cutoff] = params as [number];
      let changes = 0;
      for (const [id, row] of tables.sessions) {
        if (Number(row.last_webhook_at_ms) < Number(cutoff)) {
          tables.sessions.delete(id);
          changes++;
        }
      }
      return { results: [], meta: { changes } };
    }

    if (/^DELETE FROM webhook_events$/i.test(trimmed)) {
      const changes = tables.webhook_events.size;
      tables.webhook_events.clear();
      return { results: [], meta: { changes } };
    }

    // ----- agent_backends (added when the Isolate Sandbox backend landed) -----
    if (/^SELECT backend FROM agent_backends WHERE agent_id = \?/i.test(trimmed)) {
      const [agentId] = params as [string];
      const row = tables.agent_backends.get(agentId);
      return { results: row ? [{ backend: row.backend }] : [] };
    }
    if (/^SELECT agent_id, backend FROM agent_backends/i.test(trimmed)) {
      return { results: Array.from(tables.agent_backends.values()) };
    }
    if (/^INSERT INTO agent_backends .*ON CONFLICT/i.test(trimmed)) {
      const [agent_id, backend, updated_at_ms] = params as [string, string, number];
      tables.agent_backends.set(agent_id, { agent_id, backend, updated_at_ms });
      return { results: [], meta: { changes: 1 } };
    }
    if (/^DELETE FROM agent_backends WHERE agent_id = \?/i.test(trimmed)) {
      const [id] = params as [string];
      const had = tables.agent_backends.delete(id);
      return { results: [], meta: { changes: had ? 1 : 0 } };
    }

    // ----- sessions extra columns (last_data_json, agent_id, backend) -----
    if (/^SELECT last_data_json FROM sessions WHERE session_id = \?/i.test(trimmed)) {
      const [id] = params as [string];
      const row = tables.sessions.get(id);
      return { results: row ? [{ last_data_json: row.last_data_json ?? null }] : [] };
    }
    if (/^SELECT agent_id, backend FROM sessions WHERE session_id = \?/i.test(trimmed)) {
      const [id] = params as [string];
      const row = tables.sessions.get(id);
      return {
        results: row
          ? [{ agent_id: row.agent_id ?? null, backend: row.backend ?? null }]
          : [],
      };
    }
    if (/^UPDATE sessions SET agent_id = \?2, backend = \?3 WHERE session_id = \?1/i.test(trimmed)) {
      const [session_id, agent_id, backend] = params as [string, string | null, string];
      const row = tables.sessions.get(session_id);
      if (row) {
        row.agent_id = agent_id;
        row.backend = backend;
        return { results: [], meta: { changes: 1 } };
      }
      return { results: [], meta: { changes: 0 } };
    }

    // recordSessionAgent — pre-creates the sessions row with agent +
    // backend at session-create time so the webhook resolver skips
    // the Anthropic round-trip. Distinct from the plain upsertSession
    // matcher above because it writes the agent_id + backend columns
    // and uses a literal 'session.created' as a placeholder
    // last_webhook_type.
    if (
      /^INSERT INTO sessions \(session_id, created_at_ms, last_webhook_at_ms, last_webhook_type, agent_id, backend\)/i.test(
        trimmed,
      )
    ) {
      const [session_id, ts_ms, agent_id, backend] = params as [
        string,
        number,
        string,
        string,
      ];
      const existing = tables.sessions.get(session_id);
      if (existing) {
        existing.agent_id = agent_id;
        existing.backend = backend;
      } else {
        tables.sessions.set(session_id, {
          session_id,
          created_at_ms: ts_ms,
          last_webhook_at_ms: ts_ms,
          last_webhook_type: "session.created",
          agent_id,
          backend,
        });
      }
      return { results: [], meta: { changes: 1 } };
    }

    // ----- inbox INSERT (used by email-handler when an inbound message is persisted) -----
    if (/^INSERT INTO inbox \(/i.test(trimmed)) {
      const [
        message_id,
        session_id,
        from_addr,
        to_addr,
        subject,
        received_at_ms,
        size_bytes,
        body_text,
        body_html,
        raw_text,
      ] = params as [string, string, string, string, string, number, number, string | null, string | null, string];
      tables.inbox.set(message_id, {
        message_id,
        session_id,
        from_addr,
        to_addr,
        subject,
        received_at_ms,
        size_bytes,
        body_text,
        body_html,
        raw: raw_text,
      });
      return { results: [], meta: { changes: 1 } };
    }

    // ----- inbox prune (used by pruneOlderThan; the table is created by
    // migration 0007 in real D1, so we mirror it here for the storage tests).
    if (/^DELETE FROM inbox WHERE received_at_ms < \?/i.test(trimmed)) {
      const [cutoff] = params as [number];
      let changes = 0;
      for (const [id, row] of tables.inbox) {
        if (Number(row.received_at_ms) < Number(cutoff)) {
          tables.inbox.delete(id);
          changes++;
        }
      }
      return { results: [], meta: { changes } };
    }

    if (/^DELETE FROM sent_messages WHERE sent_at_ms < \?/i.test(trimmed)) {
      const [cutoff] = params as [number];
      let changes = 0;
      for (const [id, row] of tables.sent_messages) {
        if (Number(row.sent_at_ms) < Number(cutoff)) {
          tables.sent_messages.delete(id);
          changes++;
        }
      }
      return { results: [], meta: { changes } };
    }

    // ----- agent_emails -----
    if (/^SELECT agent_id FROM agent_emails WHERE alias = \?/i.test(trimmed)) {
      const [alias] = params as [string];
      const row = tables.agent_emails.get(alias);
      return { results: row ? [{ agent_id: row.agent_id }] : [] };
    }
    if (/^SELECT alias FROM agent_emails WHERE agent_id = \? AND is_primary = 1 LIMIT 1/i.test(trimmed)) {
      const [agentId] = params as [string];
      for (const row of tables.agent_emails.values()) {
        if (row.agent_id === agentId && Number(row.is_primary) === 1) {
          return { results: [{ alias: row.alias }] };
        }
      }
      return { results: [] };
    }
    if (/^INSERT OR IGNORE INTO agent_emails/i.test(trimmed)) {
      const [alias, agent_id, created_at_ms] = params as [string, string, number];
      if (!tables.agent_emails.has(alias)) {
        tables.agent_emails.set(alias, {
          alias,
          agent_id,
          is_primary: 1,
          created_at_ms,
        });
        return { results: [], meta: { changes: 1 } };
      }
      return { results: [], meta: { changes: 0 } };
    }

    // ----- sent_messages -----
    if (/^INSERT OR REPLACE INTO sent_messages/i.test(trimmed)) {
      const [message_id, session_id, agent_id, to_addr, sent_at_ms] = params as [
        string,
        string,
        string,
        string,
        number,
      ];
      tables.sent_messages.set(message_id, {
        message_id,
        session_id,
        agent_id,
        to_addr,
        sent_at_ms,
      });
      return { results: [], meta: { changes: 1 } };
    }
    if (/^SELECT session_id, agent_id FROM sent_messages WHERE message_id = \?/i.test(trimmed)) {
      const [messageId] = params as [string];
      const row = tables.sent_messages.get(messageId);
      return {
        results: row
          ? [{ session_id: row.session_id, agent_id: row.agent_id }]
          : [],
      };
    }

    // ----- email_threads -----
    if (/^SELECT session_id FROM email_threads WHERE agent_id = \?1 AND counterparty = \?2/i.test(trimmed)) {
      const [agent_id, counterparty] = params as [string, string];
      const key = `${agent_id}\x00${counterparty}`;
      const row = tables.email_threads.get(key);
      return { results: row ? [{ session_id: row.session_id }] : [] };
    }
    if (/^INSERT INTO email_threads .*ON CONFLICT/i.test(trimmed)) {
      const [agent_id, counterparty, session_id, last_message_at_ms] = params as [
        string,
        string,
        string,
        number,
      ];
      const key = `${agent_id}\x00${counterparty}`;
      tables.email_threads.set(key, {
        agent_id,
        counterparty,
        session_id,
        last_message_at_ms,
      });
      return { results: [], meta: { changes: 1 } };
    }
    if (/^UPDATE email_threads SET last_message_at_ms = \?3 WHERE agent_id = \?1 AND counterparty = \?2/i.test(trimmed)) {
      const [agent_id, counterparty, last_message_at_ms] = params as [
        string,
        string,
        number,
      ];
      const key = `${agent_id}\x00${counterparty}`;
      const row = tables.email_threads.get(key);
      if (row) {
        row.last_message_at_ms = last_message_at_ms;
        return { results: [], meta: { changes: 1 } };
      }
      return { results: [], meta: { changes: 0 } };
    }

    throw new Error(`fake-db: unrecognised SQL: ${trimmed}`);
  }

  const db = {
    prepare(sql: string) {
      const params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params.push(...args);
          return stmt;
        },
        async run() {
          return exec(sql, params);
        },
        async all<T>() {
          return exec(sql, params) as { results: T[] };
        },
        async first<T>() {
          const r = exec(sql, params);
          return (r.results[0] as T) ?? null;
        },
      };
      return stmt;
    },
    _tables: tables,
  } as unknown as D1Database & { _tables: FakeTables };

  return db;
}

// ---- Env factory ----

export interface FakeEnv {
  DB: ReturnType<typeof makeDb>;
  SECRETS: ReturnType<typeof makeKv>;
  EGRESS_POLICIES: ReturnType<typeof makeKv>;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_ENVIRONMENT_KEY: string;
  ENVIRONMENT_ID: string;
  WEBHOOK_SECRET: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ANTHROPIC_BASE_URL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  Sandbox: unknown;
  ASSETS: unknown;
  PROXY_LOADER: unknown;
}

export function makeEnv(overrides: Partial<FakeEnv> = {}): FakeEnv {
  return {
    DB: makeDb(),
    SECRETS: makeKv(),
    EGRESS_POLICIES: makeKv(),
    ANTHROPIC_API_KEY: "test-anth-key",
    ANTHROPIC_ENVIRONMENT_KEY: "test-env-key",
    ENVIRONMENT_ID: "env_test",
    WEBHOOK_SECRET: "test-webhook-secret",
    Sandbox: {},
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    PROXY_LOADER: {},
    ...overrides,
  };
}
