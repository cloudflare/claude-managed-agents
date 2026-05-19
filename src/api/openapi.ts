// OpenAPI 3.1.0 spec for the Worker's HTTP surface. Hand-written rather than
// generated so it stays readable and we don't have to bolt zod-openapi onto
// every existing handler. Served at GET /api/openapi.json and rendered by the
// frontend's API Reference view via Scalar.
//
// Coverage:
//   - /api/* — the dashboard's own routes (secrets, environments, agents,
//     sessions, egress policies, VPC, webhook events, config, defaults).
//   - /webhooks — Anthropic webhook ingress.
//   - /ws/terminal — PTY WebSocket upgrade.
//
// When you add or change a route in src/api/index.ts (or src/index.ts), update this
// file too. The frontend pulls /api/openapi.json on every visit, so a stale
// spec is immediately visible in the UI.

export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  servers?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
  security?: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string", description: "Human-readable error message." },
  },
} as const;

const sessionIdParam = {
  name: "sessionId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^(?:session|sesn)_[^/]+$" },
  description: "Anthropic session id (format: `session_*` or `sesn_*`).",
} as const;

const agentIdParam = {
  name: "agentId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^agent_[^/]+$" },
  description: "Anthropic agent id (format: `agent_*`).",
} as const;

const policyIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^pol_[A-Za-z0-9._-]{1,64}$" },
  description: "Egress policy id (format: `pol_*`).",
} as const;

const secretKeyParam = {
  name: "key",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
  description:
    "Secret key. Stored under `secret:<key>` in the SECRETS KV namespace.",
} as const;

export function buildOpenApiSpec(origin?: string): OpenApiDocument {
  const servers = origin
    ? [{ url: origin, description: "This deployment" }]
    : undefined;

  return {
    openapi: "3.1.0",
    info: {
      title: "Claude Managed Agents Cloudflare Control Plane API",
      version: "0.1.0",
      description: [
        "HTTP API exposed by the Claude Managed Agents Control Plane Worker.",
        "",
        "The Worker is a Workers-based control-plane for Claude Managed Agents on Cloudflare's Developer Platform.",
        "It exposes a small REST surface used by the bundled dashboard plus a webhook ingress for Anthropic.",
        "",
        "**Discovery for tooling.** This document is also served at the conventional root path `/openapi.json`",
        "(alias `/openapi`), with CORS open so browser-side agents can fetch it directly. Use either path —",
        "they return identical content. The dashboard renders this document at `/redoc.html`.",
        "",
        "Most endpoints under `/api/agents` and `/api/sessions` proxy to Anthropic's Managed Agents API after",
        "applying local transforms (backend selection, custom-tool catalog rewriting, server-side tool defaults).",
        "Their request and response shapes follow Anthropic's API; consult the Managed Agents docs for the",
        "authoritative schemas.",
      ].join("\n"),
      license: { name: "MIT" },
    },
    ...(servers ? { servers } : {}),
    tags: [
      {
        name: "Environments",
        description: "MicroVM Sandbox + Isolate Sandbox session lifecycle.",
      },
      {
        name: "Workspace",
        description: "Read the Isolate Sandbox SQLite-backed workspace.",
      },
      {
        name: "Agents",
        description:
          "Claude Managed Agents — proxied with local backend metadata.",
      },
      {
        name: "Sessions",
        description: "Claude Managed Agent sessions — proxied.",
      },
      {
        name: "Webhook events",
        description: "Recorded ingress from Anthropic webhooks.",
      },
      {
        name: "Egress policies",
        description: "Allow / deny / header-injection / proxy / VPC rules.",
      },
      {
        name: "Secrets",
        description: "Header-injection values keyed by name in KV.",
      },
      {
        name: "VPC + Mesh",
        description: "VPC bindings declared in wrangler.jsonc.",
      },
      {
        name: "Config",
        description: "Read-only worker configuration surface.",
      },
      { name: "Webhooks", description: "Anthropic webhook ingress." },
      {
        name: "Terminal",
        description: "PTY WebSocket for MicroVM Sandbox containers.",
      },
    ],
    security: [{ cloudflareAccessJwt: [] }],
    paths: {
      "/api/secrets": {
        get: {
          tags: ["Secrets"],
          summary: "List secret keys",
          description:
            "Returns names + last-updated timestamps. Secret values are never returned by this endpoint — fetch a single secret to read its value.",
          parameters: [
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "KV pagination cursor returned by a previous call.",
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 1000,
                default: 100,
              },
            },
          ],
          responses: {
            "200": {
              description: "Page of secret keys.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            key: { type: "string" },
                            updatedAt: {
                              type: ["string", "null"],
                              format: "date-time",
                            },
                          },
                        },
                      },
                      cursor: { type: ["string", "null"] },
                      hasMore: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/secrets/{key}": {
        parameters: [secretKeyParam],
        get: {
          tags: ["Secrets"],
          summary: "Read a secret value",
          responses: {
            "200": {
              description: "Secret value.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      value: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Invalid key.",
              content: { "application/json": { schema: errorSchema } },
            },
            "404": {
              description: "Not found.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
        put: {
          tags: ["Secrets"],
          summary: "Create or update a secret",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["value"],
                  properties: {
                    value: {
                      type: "string",
                      minLength: 1,
                      description: "Plain-text secret value.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Saved.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      status: { type: "string", enum: ["saved"] },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Invalid key or empty value.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
        delete: {
          tags: ["Secrets"],
          summary: "Delete a secret",
          responses: {
            "200": {
              description: "Deleted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      status: { type: "string", enum: ["deleted"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/environments": {
        get: {
          tags: ["Environments"],
          summary: "List sandboxed sessions",
          description:
            "Returns local D1-tracked sessions, each augmented with its backend (MicroVM/Isolate) and current container/runner status. Paginated.",
          parameters: [
            {
              name: "page",
              in: "query",
              schema: { type: "integer", minimum: 1, default: 1 },
            },
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
            },
          ],
          responses: {
            "200": {
              description: "Page of sessions.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            sessionId: { type: "string" },
                            agentId: { type: ["string", "null"] },
                            createdAt: { type: "string", format: "date-time" },
                            backend: {
                              type: "string",
                              enum: ["microvm", "isolate"],
                            },
                            containerStatus: { type: "string" },
                          },
                        },
                      },
                      total: { type: "integer" },
                      page: { type: "integer" },
                      limit: { type: "integer" },
                      pages: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/environments/drain": {
        post: {
          tags: ["Environments"],
          summary: "Drain pending work",
          description:
            "Manually pull queued work items from Anthropic and dispatch them to sandboxes. Useful for catching pending work without waiting for the next webhook delivery.",
          responses: {
            "200": {
              description: "Drain dispatched.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["ok"] },
                      spawned: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            session_id: { type: "string" },
                            work_id: { type: "string" },
                            created: { type: "boolean" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/environments/{sessionId}/stop": {
        parameters: [sessionIdParam],
        post: {
          tags: ["Environments"],
          summary: "Stop a sandbox",
          description:
            "Stops the running container or isolate runner for a session. MicroVM sandboxes are snapshotted to R2 first (best-effort) so the workspace can be restored on the next dispatch.",
          responses: {
            "200": {
              description: "Stopped.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessionId: { type: "string" },
                      backend: { type: "string", enum: ["microvm", "isolate"] },
                      status: { type: "string", enum: ["stopped"] },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Invalid session id.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
      },
      "/api/environments/{sessionId}/exec": {
        parameters: [sessionIdParam],
        post: {
          tags: ["Environments"],
          summary: "Run a one-off shell command",
          description:
            "Executes a shell command inside the sandbox container. **MicroVM-only** — Isolate Sandbox sessions return 409.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["command"],
                  properties: { command: { type: "string", minLength: 1 } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Command finished.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      exitCode: { type: "integer" },
                      stdout: { type: "string" },
                      stderr: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Bad request.",
              content: { "application/json": { schema: errorSchema } },
            },
            "409": {
              description: "Backend does not support exec.",
              content: { "application/json": { schema: errorSchema } },
            },
            "500": {
              description: "Sandbox error.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
      },
      "/api/environments/{sessionId}/status": {
        parameters: [sessionIdParam],
        get: {
          tags: ["Environments"],
          summary: "Read sandbox status",
          responses: {
            "200": {
              description: "Status.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessionId: { type: "string" },
                      backend: { type: "string", enum: ["microvm", "isolate"] },
                      containerStatus: {
                        type: "string",
                        description:
                          "MicroVM: `running`, `stopped`, etc., as reported by the Sandbox SDK. Isolate: `running`, `stopped`, `unknown`.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/environments/{sessionId}/workspace": {
        parameters: [sessionIdParam],
        get: {
          tags: ["Workspace"],
          summary: "List workspace entries",
          description:
            "Browse the SQLite-backed workspace inside an Isolate Sandbox. **Isolate-only.**",
          parameters: [
            {
              name: "path",
              in: "query",
              schema: { type: "string", default: "/" },
            },
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 1000,
                default: 500,
              },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
          ],
          responses: {
            "200": {
              description: "Directory listing.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      entries: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            kind: { type: "string", enum: ["file", "dir"] },
                            size: { type: "integer" },
                            mtime: { type: "string", format: "date-time" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "409": {
              description: "Backend does not support workspace browse.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
      },
      "/api/environments/{sessionId}/workspace/file": {
        parameters: [sessionIdParam],
        get: {
          tags: ["Workspace"],
          summary: "Read a workspace file",
          parameters: [
            {
              name: "path",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Absolute file path inside the workspace.",
            },
          ],
          responses: {
            "200": {
              description: "File content.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" },
                      encoding: { type: "string", enum: ["utf-8", "base64"] },
                      size: { type: "integer" },
                    },
                  },
                },
              },
            },
            "404": {
              description: "Not found.",
              content: { "application/json": { schema: errorSchema } },
            },
            "409": {
              description: "Not Isolate.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
      },
      "/api/environments/{sessionId}/workspace/info": {
        parameters: [sessionIdParam],
        get: {
          tags: ["Workspace"],
          summary: "Workspace metadata",
          responses: {
            "200": {
              description: "Total size, file count, etc.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "409": {
              description: "Not Isolate.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
      },
      "/api/webhook-events": {
        get: {
          tags: ["Webhook events"],
          summary: "List recorded webhook events",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 200,
                default: 50,
              },
            },
            {
              name: "cursor",
              in: "query",
              schema: { type: "string" },
              description:
                "Millisecond timestamp from a previous response's `cursor`.",
            },
          ],
          responses: {
            "200": {
              description: "Page of events.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { type: "object" } },
                      cursor: { type: ["string", "null"] },
                      hasMore: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          tags: ["Webhook events"],
          summary: "Delete all recorded webhook events",
          responses: {
            "200": {
              description: "Deleted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { deleted: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      },
      "/api/webhook-events/{eventId}": {
        parameters: [
          {
            name: "eventId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        get: {
          tags: ["Webhook events"],
          summary: "Read a single webhook event",
          responses: {
            "200": {
              description: "Event payload.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "404": {
              description: "Not found.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
      },
      "/api/egress-policies": {
        get: {
          tags: ["Egress policies"],
          summary: "List egress policies",
          responses: {
            "200": {
              description: "Items.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/EgressPolicy" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/egress-policies/data-fields": {
        get: {
          tags: ["Egress policies"],
          summary: "List known webhook data fields",
          description:
            "Auto-suggestions for the policy editor's `Apply to` matcher. Seeded with standard webhook attributes and grown over time as new attributes show up on delivered webhooks.",
          responses: {
            "200": {
              description: "Field names.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/egress-policies/{id}": {
        parameters: [policyIdParam],
        get: {
          tags: ["Egress policies"],
          summary: "Read a policy",
          responses: {
            "200": {
              description: "Policy.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EgressPolicy" },
                },
              },
            },
            "404": {
              description: "Not found.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
        put: {
          tags: ["Egress policies"],
          summary: "Create or update a policy",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EgressPolicy" },
              },
            },
          },
          responses: {
            "200": {
              description: "Saved policy.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EgressPolicy" },
                },
              },
            },
            "400": {
              description: "Validation error.",
              content: { "application/json": { schema: errorSchema } },
            },
          },
        },
        delete: {
          tags: ["Egress policies"],
          summary: "Delete a policy",
          responses: {
            "200": {
              description: "Deleted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      status: { type: "string", enum: ["deleted"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/vpc": {
        get: {
          tags: ["VPC + Mesh"],
          summary: "List VPC bindings",
          description:
            "Returns the bindings declared in `wrangler.jsonc` (vpc_networks + vpc_services), as harvested by `scripts/sync-vpc-bindings.mjs` at build time.",
          responses: {
            "200": {
              description: "Bindings.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            kind: {
                              type: "string",
                              enum: ["network", "service"],
                            },
                            binding: { type: "string" },
                            id: { type: "string" },
                            remote: { type: "boolean" },
                          },
                        },
                      },
                      docsUrl: { type: "string", format: "uri" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/config": {
        get: {
          tags: ["Config"],
          summary: "Read worker configuration",
          description:
            "Returns the environment id in use, the Anthropic base URL, a list of any required secrets that aren't configured, and a `capabilities` block describing which optional bindings / secrets are wired up. Used by the dashboard's setup and snapshot banners and to gate tool toggles in the agent form.",
          responses: {
            "200": {
              description: "Config snapshot.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      environmentId: { type: ["string", "null"] },
                      anthropicBaseURL: { type: "string", format: "uri" },
                      missing: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Names of required secrets/vars that aren't set.",
                      },
                      capabilities: {
                        type: "object",
                        description:
                          "Optional-binding flags. Each field reflects whether the corresponding feature is fully wired up on this deployment.",
                        properties: {
                          snapshots: {
                            type: "boolean",
                            description:
                              "True when the BACKUP_BUCKET R2 binding is present.",
                          },
                          snapshotsMode: {
                            type: "string",
                            enum: ["presigned", "localBucket", "disabled"],
                            description:
                              "`presigned` requires R2 access keys + account id; `localBucket` falls back to the binding directly (suitable for `wrangler dev`); `disabled` means BACKUP_BUCKET is missing entirely.",
                          },
                          browserRendering: { type: "boolean" },
                          workersAi: { type: "boolean" },
                          emailSend: { type: "boolean" },
                          emailInbox: { type: "boolean" },
                          hasMicrovmAgents: {
                            type: "boolean",
                            description:
                              "True when the operator has an active MicroVM footprint (a microvm session, a microvm agent row, or no agents yet — defaults to microvm).",
                          },
                        },
                      },
                      openapi: {
                        type: ["object", "null"],
                        description:
                          "Discovery pointers for the OpenAPI document. `json` is the canonical root alias, `legacy` is the original `/api/openapi.json` path (kept for backwards compatibility), and `reference` is the human-readable Redoc page.",
                        properties: {
                          json: { type: "string", format: "uri" },
                          legacy: { type: "string", format: "uri" },
                          reference: { type: "string", format: "uri" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/isolate/defaults": {
        get: {
          tags: ["Config"],
          summary: "Isolate Sandbox defaults",
          description:
            "Default system prompt the agent form pre-fills for Isolate-backed agents.",
          responses: {
            "200": {
              description: "Defaults.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { systemPrompt: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      "/api/microvm/defaults": {
        get: {
          tags: ["Config"],
          summary: "MicroVM Sandbox defaults",
          description:
            "Default system prompt the agent form pre-fills for MicroVM-backed agents.",
          responses: {
            "200": {
              description: "Defaults.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { systemPrompt: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      "/api/custom-tools": {
        get: {
          tags: ["Config"],
          summary: "List user-defined custom tools",
          description: [
            "Returns the tools declared in `src/tools/custom-tools.ts`, each marked `available` based on its",
            "`requires` predicate against the live env. Kept for backwards compatibility — the full",
            "agent tool catalog (built-ins + cf_* + custom) is also available at `/api/tool-catalog`.",
          ].join(" "),
          responses: {
            "200": {
              description: "Custom tools.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      tools: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            description: { type: "string" },
                            available: { type: "boolean" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/tool-catalog": {
        get: {
          tags: ["Config"],
          summary: "Full agent tool catalog",
          description: [
            "Returns every tool the agent form can offer, grouped by where it runs:",
            "`microvmStock` (in-container SDK tools), `serverSide` (Anthropic infrastructure —",
            "bypasses the operator's egress policy), `isolateWorkspace` / `isolatePower`",
            "(Isolate Sandbox workspace + code/browser tools), `cfTools` (binding-backed tools",
            "shared across both backends), and `custom` (user-defined tools from",
            "`src/tools/custom-tools.ts`). The dashboard reads this once per agent form render and",
            "builds the checkbox grid from it — adding a new tool surfaces in the UI on the",
            "next deploy without any frontend edits.",
          ].join(" "),
          responses: {
            "200": {
              description: "Tool catalog.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      microvmStock: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/ToolCatalogEntry",
                        },
                      },
                      serverSide: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/ToolCatalogEntry",
                        },
                      },
                      isolateWorkspace: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/ToolCatalogEntry",
                        },
                      },
                      isolatePower: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/ToolCatalogEntry",
                        },
                      },
                      cfTools: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/ToolCatalogEntry",
                        },
                      },
                      custom: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/ToolCatalogEntry",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/agents": {
        get: {
          tags: ["Agents"],
          summary: "List agents",
          description:
            "Proxies Anthropic's `GET /v1/agents` and augments each item with the backend (`microvm`/`isolate`) tracked in local D1.",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "string", default: "100" },
            },
          ],
          responses: {
            "200": {
              description: "Agents page (Anthropic shape + `backend` field).",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
        post: {
          tags: ["Agents"],
          summary: "Create an agent",
          description:
            'Proxies Anthropic\'s `POST /v1/agents` after rewriting the `tools` array to match the chosen backend. Both backends use `type: "custom"` entries for cf_* + user-defined tools; MicroVM additionally keeps the stock `agent_toolset_20260401` wrapper for the in-container SDK runner.',
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description:
                    "Anthropic agent payload, plus a `backend` field — either `microvm` or `isolate` (legacy `sandbox`/`think` accepted).",
                  properties: {
                    backend: { type: "string", enum: ["microvm", "isolate"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Created agent.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/agents/{agentId}": {
        parameters: [agentIdParam],
        get: {
          tags: ["Agents"],
          summary: "Read an agent",
          responses: {
            "200": {
              description: "Agent (Anthropic shape + `backend`).",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
        post: {
          tags: ["Agents"],
          summary: "Update an agent",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": {
              description: "Updated agent.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/agents/{agentId}/backend": {
        parameters: [agentIdParam],
        get: {
          tags: ["Agents"],
          summary: "Read the persisted backend choice",
          description:
            "Per-agent backend (microvm vs isolate) is stored locally in D1 because Anthropic's `/v1/agents` has no durable user-metadata field.",
          responses: {
            "200": {
              description: "Backend.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      agentId: { type: "string" },
                      backend: { type: "string", enum: ["microvm", "isolate"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/agents/{agentId}/archive": {
        parameters: [agentIdParam],
        post: {
          tags: ["Agents"],
          summary: "Archive an agent",
          description:
            "Proxies Anthropic's archive endpoint and clears the local backend row.",
          responses: {
            "200": { description: "Archived." },
          },
        },
      },
      "/api/sessions": {
        get: {
          tags: ["Sessions"],
          summary: "List sessions",
          description:
            "Proxies Anthropic's `GET /v1/sessions`. Each session is augmented with the backend (`microvm`/`isolate`) cached in local D1. The optional `backend` query param filters the result to one backend before returning.",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "string", default: "100" },
            },
            {
              name: "backend",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["microvm", "isolate"] },
              description:
                "Scope the list to a single backend. Omit to return both.",
            },
          ],
          responses: {
            "200": {
              description: "Anthropic response.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
        post: {
          tags: ["Sessions"],
          summary: "Create a session",
          description:
            "Proxies Anthropic's `POST /v1/sessions`, injecting `environment` from the worker's `ENVIRONMENT_ID` when the caller doesn't supply one.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": {
              description: "Created session.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/sessions/{sessionId}": {
        parameters: [sessionIdParam],
        get: {
          tags: ["Sessions"],
          summary: "Read a session",
          responses: {
            "200": {
              description: "Anthropic response.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/sessions/{sessionId}/events": {
        parameters: [sessionIdParam],
        get: {
          tags: ["Sessions"],
          summary: "List session events",
          description:
            "Proxies Anthropic's events endpoint. Query string is forwarded verbatim.",
          responses: {
            "200": {
              description: "Anthropic response.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
        post: {
          tags: ["Sessions"],
          summary: "Append a session event",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": {
              description: "Anthropic response.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/sessions/{sessionId}/archive": {
        parameters: [sessionIdParam],
        post: {
          tags: ["Sessions"],
          summary: "Archive a session",
          responses: {
            "200": {
              description: "Anthropic response.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/openapi.json": {
        get: {
          tags: ["Config"],
          summary: "OpenAPI document",
          description: [
            "This document. Served as JSON for the dashboard's API Reference view.",
            "Also exposed at the conventional root path `/openapi.json` (alias `/openapi`)",
            "for CLI and agent tooling that probes the well-known location. Both paths",
            "return identical content with `Access-Control-Allow-Origin: *` so browser-side",
            "agents can fetch the document cross-origin.",
          ].join(" "),
          responses: {
            "200": {
              description: "OpenAPI 3.1 spec.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["Config"],
          summary: "OpenAPI document (root alias)",
          description:
            "Convenience alias for `/api/openapi.json`. Tools that probe the conventional root path land here. Identical payload; CORS is open. `/openapi` (no extension) is also accepted.",
          responses: {
            "200": {
              description: "OpenAPI 3.1 spec.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/webhooks": {
        post: {
          tags: ["Webhooks"],
          summary: "Anthropic webhook ingress",
          security: [{ standardWebhookSignature: [] }],
          description: [
            "Receives webhook deliveries from Anthropic's Managed Agents API. Verified using HMAC-SHA256",
            "against `WEBHOOK_SECRET` (Standard Webhooks signature header).",
            "",
            "Successful deliveries are persisted to the `webhook_events` D1 table and used to drive sandbox",
            "dispatch.",
          ].join("\n"),
          parameters: [
            {
              name: "webhook-id",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "webhook-timestamp",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "webhook-signature",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": { description: "Accepted." },
            "400": { description: "Malformed payload." },
            "401": { description: "Signature verification failed." },
          },
        },
      },
      "/ws/terminal": {
        get: {
          tags: ["Terminal"],
          summary: "Open a PTY WebSocket",
          description: [
            "WebSocket upgrade. The frontend opens `ws(s)://<host>/ws/terminal?session=<id>&cols=<n>&rows=<n>`",
            "and pipes it to xterm.js. The Worker forwards the upgrade to the matching MicroVM Sandbox DO.",
            "",
            "**MicroVM-only.** Isolate-Sandbox sessions are rejected with 409.",
          ].join("\n"),
          parameters: [
            {
              name: "session",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "cols",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "rows",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "Upgrade",
              in: "header",
              required: true,
              schema: { type: "string", enum: ["websocket"] },
            },
          ],
          responses: {
            "101": {
              description: "Switching Protocols — WebSocket established.",
            },
            "400": { description: "Invalid session id." },
            "409": { description: "Backend has no shell (Isolate)." },
            "426": { description: "Upgrade required." },
            "502": { description: "Sandbox unavailable." },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        cloudflareAccessJwt: {
          type: "apiKey",
          in: "header",
          name: "Cf-Access-Jwt-Assertion",
          description:
            "Cloudflare Access JWT added by the Access-protected application and validated by the Worker.",
        },
        standardWebhookSignature: {
          type: "apiKey",
          in: "header",
          name: "webhook-signature",
          description:
            "Standard Webhooks HMAC signature. `webhook-id` and `webhook-timestamp` headers are also required.",
        },
      },
      schemas: {
        EgressPolicy: {
          type: "object",
          required: ["id", "name", "egressRules", "applyTo"],
          properties: {
            id: { type: "string", pattern: "^pol_[A-Za-z0-9._-]{1,64}$" },
            name: { type: "string", minLength: 1 },
            egressRules: {
              type: "array",
              items: { $ref: "#/components/schemas/EgressRule" },
            },
            applyTo: {
              type: "array",
              items: { $ref: "#/components/schemas/ApplyToMatcher" },
              description:
                "Matchers against incoming webhook data. Mutually exclusive with `appliesToAll`.",
            },
            appliesToAll: { type: "boolean" },
            sessionIds: {
              type: "array",
              items: { type: "string" },
              description: "Legacy. No longer surfaced in the UI.",
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        EgressRule: {
          oneOf: [
            {
              type: "object",
              required: ["type", "host"],
              properties: {
                type: { type: "string", enum: ["allow"] },
                host: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "host"],
              properties: {
                type: { type: "string", enum: ["deny"] },
                host: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "target", "header", "secretName"],
              properties: {
                type: { type: "string", enum: ["header-injection"] },
                target: { type: "string" },
                header: { type: "string" },
                secretName: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "code"],
              properties: {
                type: { type: "string", enum: ["proxy"] },
                code: { type: "string" },
              },
            },
            {
              type: "object",
              required: ["type", "binding", "hostname"],
              properties: {
                type: { type: "string", enum: ["vpc-service"] },
                binding: { type: "string" },
                hostname: { type: "string" },
              },
            },
          ],
        },
        ApplyToMatcher: {
          type: "object",
          required: ["field", "operator"],
          properties: {
            field: { type: "string" },
            operator: {
              type: "string",
              enum: ["equals", "contains", "matches", "is-one-of"],
            },
            value: { type: "string" },
            values: { type: "array", items: { type: "string" } },
          },
        },
        ToolCatalogEntry: {
          type: "object",
          required: ["name", "displayName", "description"],
          properties: {
            name: {
              type: "string",
              description:
                "Wire name sent to Anthropic (e.g. `cf_web_fetch` for binding-backed tools).",
            },
            displayName: {
              type: "string",
              description:
                "Prefix-stripped label used by the dashboard checkboxes.",
            },
            description: { type: "string" },
            requires: {
              type: ["string", "null"],
              description:
                "Capability tag the tool depends on (e.g. `browser-rendering`, `workers-ai`, `loader`). Absent for unconditional tools.",
            },
            available: {
              type: "boolean",
              description:
                "Present on entries that have a `requires` gate. False entries still render in the UI but are disabled with a hint.",
            },
            microvmEligible: {
              type: "boolean",
              description:
                "Set on `isolatePower` entries that can also be hosted by the MicroVM backend (currently the `loader+browser` browser CDP tools). The dashboard surfaces these in the MicroVM checkbox grid alongside cf_* tools.",
            },
          },
        },
      },
    },
  };
}
