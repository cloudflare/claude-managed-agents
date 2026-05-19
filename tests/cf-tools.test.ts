import { describe, expect, it, vi } from "vitest";

vi.mock("../src/vpc.generated", () => ({
  VPC_BINDINGS: [
    { binding: "RESPONDY", type: "service", id: "service-respondy" },
  ],
}));

import {
  CF_TOOL_DEFS,
  buildCfTools,
  cfToolGroups,
  detectImageMime,
  evaluateCfRequires,
} from "../src/tools/cf";
import {
  buildIsolateAgentTools,
  buildMicrovmCustomTools,
  isolateCapabilitiesFromEnv,
  ISOLATE_TOOL_NAMES,
} from "../src/tools/schemas";
import { buildCfCallServiceSchema } from "../src/tools/cf/vpc";

// Magic-byte detection. The Workers AI binding switches between PNG and
// JPEG output depending on which model is loaded — FLUX 1 Schnell returns
// JPEG, older models return PNG. Without correct mime types the inline
// image content block gets refused by Anthropic with a content-type
// mismatch.
describe("detectImageMime", () => {
  it("identifies PNG from \\x89PNG header", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    expect(detectImageMime(png)).toBe("image/png");
  });

  it("identifies JPEG from \\xff\\xd8\\xff header", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    ]);
    expect(detectImageMime(jpeg)).toBe("image/jpeg");
  });

  it("identifies GIF from GIF8 header", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageMime(gif)).toBe("image/gif");
  });

  it("identifies WEBP from RIFF...WEBP header", () => {
    const webp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // size (unused for detect)
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
    ]);
    expect(detectImageMime(webp)).toBe("image/webp");
  });

  it("falls back to image/png for unknown magic", () => {
    const garbage = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectImageMime(garbage)).toBe("image/png");
  });
});

// Tool-catalog gating. Without it, the model sees every Cloudflare
// tool the frontend offers even when the matching binding is absent
// on the deployment. Calling such a tool returns "tool not implemented"
// from the dispatcher and wastes a model turn.
//
// Naming: the prefix-on-collision policy keeps `cf_read` / `cf_write`
// / `cf_edit` / `cf_grep` / `cf_web_fetch` prefixed (would collide with
// Anthropic-reserved names). Every other tool is unprefixed.
describe("buildIsolateAgentTools", () => {
  it("returns workspace tools unfiltered when no env is supplied", () => {
    const names = ["cf_read", "cf_write", "cf_web_fetch"];
    const out = buildIsolateAgentTools(names);
    expect(out.map((t) => t.name)).toEqual([
      "cf_read",
      "cf_write",
      "cf_web_fetch",
    ]);
  });

  it("drops Cloudflare tools whose binding gate isn't satisfied", () => {
    const env = makeBaseEnv();
    const out = buildIsolateAgentTools(
      ["cf_read", "cf_web_fetch", "image_generate", "email_send"],
      env,
      false,
    );
    // No bindings → only the workspace tool survives.
    expect(out.map((t) => t.name)).toEqual(["cf_read"]);
  });

  it("keeps Cloudflare tools whose binding is wired up", () => {
    const env = makeBaseEnv({ BROWSER: { fetch: () => null }, AI: {} });
    const out = buildIsolateAgentTools(
      ["cf_read", "cf_web_fetch", "image_generate", "email_send"],
      env,
      false,
    );
    expect(out.map((t) => t.name).sort()).toEqual(
      ["image_generate", "cf_web_fetch", "cf_read"].sort(),
    );
    // email_send dropped — no SEND_EMAIL binding.
    expect(out.find((t) => t.name === "email_send")).toBeUndefined();
  });

  it("respects explicit vpcAvailable override", () => {
    const env = makeBaseEnv();
    const withVpc = buildIsolateAgentTools(["call_service"], env, true);
    expect(withVpc.map((t) => t.name)).toEqual(["call_service"]);
    const withoutVpc = buildIsolateAgentTools(["call_service"], env, false);
    expect(withoutVpc).toEqual([]);
  });

  it("drops unknown tool names with a warn log", () => {
    const out = buildIsolateAgentTools(["cf_read", "made_up_tool"]);
    expect(out.map((t) => t.name)).toEqual(["cf_read"]);
  });

  // Anthropic's `/v1/agents` rejects any `input_schema` that contains a
  // `$ref` — Zod v4 with `reused: "ref"` hoists sub-schemas into `$defs`
  // whenever a property is `.default()`/`.optional()` followed by
  // `.describe()`, which is common in the cf_* schemas. We strip `$defs`
  // before sending, so leftover refs would dangle and the API rejects
  // the agent create. This pins the rendered payload to be fully inlined.
  it("emits input schemas with no $ref / $defs / $schema", () => {
    const env = makeBaseEnv({
      BROWSER: { fetch: () => null },
      AI: {},
      SEND_EMAIL: {},
      DB: {},
    });
    const everyCfName = [
      "cf_web_fetch",
      "fetch_to_markdown",
      "browse",
      "screenshot",
      "image_generate",
      "email_send",
      "email_inbox",
      "email_read",
    ];
    const out = buildIsolateAgentTools(everyCfName, env, false);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("$ref");
    expect(wire).not.toContain("$defs");
    expect(wire).not.toContain("$schema");
    // Spot-check `cf_web_fetch` — the schema that originally tripped the
    // API. Its `format` enum and `max_chars` integer should be inlined.
    const fetchTool = out.find((t) => t.name === "cf_web_fetch");
    const format = fetchTool?.input_schema.properties?.format as Record<
      string,
      unknown
    >;
    expect(format?.type).toBe("string");
    expect(format?.enum).toEqual(["markdown", "html"]);
  });

  // Anthropic validates each `pattern` with an RE2-style engine that
  // rejects lookaround. Zod's `.email()` emits a regex with two
  // negative lookaheads (`(?!\.)`, `(?!.*\.\.)`) which made
  // `email_send` fail on agent create. We strip RE2-incompatible
  // patterns while keeping the `format: "email"` hint.
  it("strips RE2-incompatible regex patterns from email fields", () => {
    const env = makeBaseEnv({ SEND_EMAIL: {}, DB: {} });
    const out = buildIsolateAgentTools(
      ["email_send", "email_inbox", "email_read"],
      env,
      false,
    );
    const wire = JSON.stringify(out);
    expect(wire).not.toMatch(/\(\?<?[=!]/);
    const emailSend = out.find((t) => t.name === "email_send");
    const toProp = emailSend?.input_schema.properties?.to as Record<
      string,
      unknown
    >;
    // `format` survives — pattern does not.
    expect(toProp?.format).toBe("email");
    expect(toProp?.pattern).toBeUndefined();
  });
});

// MicroVM path runs the same JSON schema rendering through a different
// function; the $ref / pattern bugs would surface here too without the
// shared sanitizer.
describe("buildMicrovmCustomTools", () => {
  it("emits input schemas with no $ref / $defs / $schema and no lookaround patterns", () => {
    const env = makeBaseEnv({
      BROWSER: { fetch: () => null },
      AI: {},
      SEND_EMAIL: {},
      DB: {},
    });
    const out = buildMicrovmCustomTools(
      [
        "cf_web_fetch",
        "fetch_to_markdown",
        "browse",
        "screenshot",
        "image_generate",
        "email_send",
        "email_inbox",
        "email_read",
      ],
      env,
      false,
    );
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("$ref");
    expect(wire).not.toContain("$defs");
    expect(wire).not.toContain("$schema");
    expect(wire).not.toMatch(/\(\?<?[=!]/);
  });

  // Browser CDP tools used to be Isolate-only. They're now also
  // hosted by the Sandbox DO on MicroVM (the factory spins up an
  // isolate via the parent Worker's LOADER binding and talks to
  // BROWSER directly, so the container is uninvolved). The MicroVM
  // catalog must include them when the bindings are present, and
  // drop them when they aren't.
  it("includes browser_search and browser_execute on MicroVM when LOADER+BROWSER are bound", () => {
    const env = makeBaseEnv({
      LOADER: {},
      BROWSER: { fetch: () => null },
    });
    const out = buildMicrovmCustomTools(
      ["browser_search", "browser_execute"],
      env,
      false,
    );
    expect(out.map((t) => t.name).sort()).toEqual([
      "browser_execute",
      "browser_search",
    ]);
  });

  it("drops browser tools from the MicroVM catalog when LOADER or BROWSER is missing", () => {
    const loaderOnly = makeBaseEnv({ LOADER: {} });
    const browserOnly = makeBaseEnv({ BROWSER: { fetch: () => null } });
    expect(
      buildMicrovmCustomTools(
        ["browser_search", "browser_execute"],
        loaderOnly,
        false,
      ),
    ).toEqual([]);
    expect(
      buildMicrovmCustomTools(
        ["browser_search", "browser_execute"],
        browserOnly,
        false,
      ),
    ).toEqual([]);
  });
});

describe("isolateCapabilitiesFromEnv", () => {
  it("reports false for missing bindings", () => {
    const caps = isolateCapabilitiesFromEnv(makeBaseEnv());
    expect(caps).toMatchObject({
      loader: false,
      loaderBrowser: false,
      browserRendering: false,
      workersAi: false,
      email: false,
    });
  });

  it("detects browser rendering via REST creds even without the binding", () => {
    const env = makeBaseEnv({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    });
    const caps = isolateCapabilitiesFromEnv(env);
    expect(caps.browserRendering).toBe(true);
  });

  it("requires both LOADER and BROWSER for loaderBrowser", () => {
    expect(
      isolateCapabilitiesFromEnv(makeBaseEnv({ LOADER: {} })).loaderBrowser,
    ).toBe(false);
    expect(
      isolateCapabilitiesFromEnv(makeBaseEnv({ LOADER: {}, BROWSER: {} }))
        .loaderBrowser,
    ).toBe(true);
  });
});

// The schema registry must include every name the dispatcher
// registers. Cross-checked here so a new tool added without a
// schema entry fails CI rather than at runtime.
describe("ISOLATE_TOOL_NAMES", () => {
  it("includes every known Cloudflare-side tool", () => {
    const expected = [
      // Workspace + power tools — prefix kept only where the unprefixed
      // name collides with an Anthropic-reserved built-in.
      "cf_read",
      "cf_write",
      "cf_edit",
      "list",
      "find",
      "cf_grep",
      "delete",
      "execute",
      "run_file",
      "browser_search",
      "browser_execute",
      // Cloudflare-binding-backed tools.
      "cf_web_fetch",
      "fetch_to_markdown",
      "browse",
      "screenshot",
      "image_generate",
      "call_service",
      "email_send",
      "email_inbox",
      "email_read",
    ];
    for (const name of expected) {
      expect(ISOLATE_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

// The registry drives three layers: the Isolate dispatcher, the
// MicroVM-side Sandbox DO custom-tool dispatcher, and the Anthropic
// agent payload. Drift between them was the whole reason for the
// registry refactor — these tests pin the shared contract so the next
// person to add a tool can't accidentally break it.
describe("CF_TOOL_DEFS registry", () => {
  it("exposes the documented Cloudflare-backed tool set", () => {
    const names = CF_TOOL_DEFS.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        "cf_web_fetch",
        "fetch_to_markdown",
        "browse",
        "screenshot",
        "image_generate",
        "call_service",
        "email_send",
        "email_inbox",
        "email_read",
      ].sort(),
    );
  });

  it("uses a known requires tag on every entry", () => {
    const valid = new Set(["browser-rendering", "workers-ai", "vpc", "email"]);
    for (const def of CF_TOOL_DEFS) {
      expect(valid.has(def.requires)).toBe(true);
    }
  });

  it("matches the names ISOLATE_TOOL_NAMES advertises", () => {
    for (const def of CF_TOOL_DEFS) {
      expect(ISOLATE_TOOL_NAMES.has(def.name)).toBe(true);
    }
  });
});

describe("evaluateCfRequires", () => {
  it("returns false for every tag on an empty env", () => {
    const env = makeBaseEnv();
    expect(evaluateCfRequires("browser-rendering", env)).toBe(false);
    expect(evaluateCfRequires("workers-ai", env)).toBe(false);
    expect(evaluateCfRequires("vpc", env)).toBe(false);
    expect(evaluateCfRequires("email", env)).toBe(false);
  });

  it("treats either BR REST creds or BROWSER binding as browser-rendering", () => {
    const restEnv = makeBaseEnv({
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "tok",
    });
    const bindingEnv = makeBaseEnv({ BROWSER: { fetch: () => null } });
    expect(evaluateCfRequires("browser-rendering", restEnv)).toBe(true);
    expect(evaluateCfRequires("browser-rendering", bindingEnv)).toBe(true);
  });

  it("treats either SEND_EMAIL or DB as email", () => {
    expect(evaluateCfRequires("email", makeBaseEnv({ SEND_EMAIL: {} }))).toBe(
      true,
    );
    expect(evaluateCfRequires("email", makeBaseEnv({ DB: {} }))).toBe(true);
  });
});

// cfToolGroups powers the control plane's drift detection. We don't need to
// pin every group exhaustively — just that the registry-derived
// grouping matches the gating logic. Important behaviour: enabled
// flips when the relevant binding(s) appear.
describe("cfToolGroups", () => {
  it("reports every group disabled on an empty env", () => {
    const groups = cfToolGroups(makeBaseEnv());
    expect(groups.browser.enabled).toBe(false);
    expect(groups.ai.enabled).toBe(false);
    expect(groups.vpc.enabled).toBe(false);
    expect(groups.email.enabled).toBe(false);
  });

  it("enables the browser group when Browser Rendering is configured", () => {
    const groups = cfToolGroups(
      makeBaseEnv({ BROWSER: { fetch: () => null } }),
    );
    expect(groups.browser.enabled).toBe(true);
    expect(groups.browser.names).toContain("cf_web_fetch");
    expect(groups.browser.names).toContain("screenshot");
  });
});

// VPC binding names in `wrangler.jsonc` are uppercase by convention,
// but the model often emits a lowercase variant because that's how
// the user phrased the binding in chat. Without normalisation the
// runtime schema rejects the call and the agent burns a turn
// retrying with the right case. The schema runs a `z.preprocess`
// step that maps any casing back to the canonical binding name.
describe("buildCfCallServiceSchema (case-insensitive binding)", () => {
  it("accepts a lowercase binding and normalises to canonical", () => {
    // VPC_BINDINGS.generated.ts ships with RESPONDY; ensure the env has
    // a matching fetcher so availableVpcServiceBindings picks it up.
    const env = makeBaseEnv({
      RESPONDY: { fetch: () => new Response("ok") },
    });
    const built = buildCfCallServiceSchema(env);
    expect(built).not.toBeNull();
    const parsed = built!.schema.safeParse({
      binding: "respondy",
      path: "/",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.binding).toBe("RESPONDY");
    }
  });

  it("accepts mixed case and normalises to canonical", () => {
    const env = makeBaseEnv({
      RESPONDY: { fetch: () => new Response("ok") },
    });
    const built = buildCfCallServiceSchema(env)!;
    const parsed = built.schema.safeParse({
      binding: "ResPondY",
      path: "/",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.binding).toBe("RESPONDY");
    }
  });

  it("still rejects unknown binding names", () => {
    const env = makeBaseEnv({
      RESPONDY: { fetch: () => new Response("ok") },
    });
    const built = buildCfCallServiceSchema(env)!;
    const parsed = built.schema.safeParse({
      binding: "not-a-binding",
      path: "/",
    });
    expect(parsed.success).toBe(false);
  });
});

// buildCfTools is the registry's primary consumer on the Isolate side.
// Without a real Workspace it's hard to exercise the run functions, but
// we can verify the gating: with a fully-empty env nothing registers.
describe("buildCfTools", () => {
  it("returns no tools when no cf_* bindings are configured", () => {
    const env = makeBaseEnv();
    const stubWorkspace = {
      writeFile: async () => undefined,
    } as unknown as Parameters<typeof buildCfTools>[0]["workspace"];
    const tools = buildCfTools({
      env,
      sessionId: "session_test",
      workspace: stubWorkspace,
    });
    expect(tools).toEqual([]);
  });
});

// Minimal Env stub. The schemas module only looks at a handful of binding
// keys, so we don't need the full Cloudflare types here.
function makeBaseEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    ANTHROPIC_API_KEY: "test",
    ANTHROPIC_ENVIRONMENT_KEY: "test",
    ENVIRONMENT_ID: "env",
    WEBHOOK_SECRET: "secret",
    ...overrides,
  } as unknown as Env;
}
