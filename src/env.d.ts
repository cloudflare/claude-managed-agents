// Optional secrets / vars not included in the Wrangler-generated types.
// `wrangler types` emits everything declared under `vars` / `kv_namespaces`
// / `d1_databases` / etc., but secrets pushed via `wrangler secret put`
// and optional fall-throughs (e.g. R2 access keys, Browser Rendering REST
// credentials) only show up here.
//
// Keep this list in sync with .dev.vars.example and the README so the
// type system catches typos at compile time instead of at runtime.
declare namespace Cloudflare {
  interface Env {
    // Anthropic — required secret (also declared in package.json `bindings`).
    WEBHOOK_SECRET: string;

    // Cloudflare Access — required to serve the dashboard, API, static
    // assets, OpenAPI document, and terminal WebSocket. `/webhooks` stays
    // HMAC-authenticated and bypasses this gate.
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;

    // Override the Anthropic API host. Defaults to https://api.anthropic.com
    // when unset; see `resolveAnthropicBaseURL` in src/anthropic.ts.
    ANTHROPIC_BASE_URL?: string;

    // Browser Rendering REST credentials. Either both are present (REST
    // path, faster, supports /markdown natively) or both are absent and
    // we fall back to the BROWSER binding via @cloudflare/puppeteer.
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;

    // R2 access keys for the BACKUP_BUCKET snapshot path. In production
    // the Sandbox SDK uses these to presign URLs. In dev the same
    // BACKUP_BUCKET R2 binding works without them (localBucket: true).
    // We accept either the R2_ or AWS_ prefix — both are valid Sandbox
    // SDK conventions.
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    // Name of the bucket the SDK should target when minting presigned
    // URLs. Matches `r2_buckets[].bucket_name` in wrangler.jsonc.
    BACKUP_BUCKET_NAME?: string;

    // Fallback inbox for stray (non-session) email arriving on the
    // catch-all route. When unset, unroutable mail is dropped after
    // logging.
    EMAIL_FORWARD?: string;
  }
}
