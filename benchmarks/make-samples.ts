/**
 * Writes the sample sessions under benchmarks/samples/. They are synthetic
 * but shaped like real agent work: a bug fix, an incident investigation, a
 * research task with large fetched pages, and a long refactor with enough
 * tool calls to push the Jev state through its fitting stages. Deterministic,
 * so the numbers in RESULTS.md can be reproduced.
 *
 *   npx tsx benchmarks/make-samples.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Message } from '../src/core/types.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'samples');

class Session {
  readonly messages: Message[] = [];
  private n = 0;
  user(text: string): this {
    this.messages.push({ role: 'user', text, toolUses: [] });
    return this;
  }
  say(text: string): this {
    this.messages.push({ role: 'assistant', text, toolUses: [] });
    return this;
  }
  /** An assistant turn with optional text and one tool call, followed by its result. */
  call(tool: string, input: Record<string, unknown>, output: string, options: { text?: string; isError?: boolean } = {}): this {
    const id = `call_${String(++this.n).padStart(3, '0')}`;
    this.messages.push({ role: 'assistant', text: options.text ?? '', toolUses: [{ tool_use_id: id, tool, input }] });
    this.messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError: options.isError ?? false }] });
    return this;
  }
}

const lines = (n: number, make: (i: number) => string): string => Array.from({ length: n }, (_, i) => make(i + 1)).join('\n');

function tsFile(name: string, fns: string[], extra = ''): string {
  return `${extra}import { z } from 'zod';\n\n${fns.map((fn, i) => `export function ${fn}(input: ${fn}Input): ${fn}Result {\n${lines(8 + i, (j) => `  const step${j} = transform(input, ${j}); // ${name}`)}\n  return finish(step${8 + i});\n}\n`).join('\n')}`;
}

function bugfix(): Message[] {
  const s = new Session();
  s.user('The checkout test suite fails on main since this morning: `pnpm test --filter checkout` reports `TestApplyCoupon` failing. Find the cause and fix it. Do not touch anything under packages/legacy/.')
    .say('I will start by reproducing the failure.')
    .call('Bash', { command: 'pnpm test --filter checkout' }, `> checkout@2.4.1 test\n> vitest run\n\n FAIL  src/coupon.test.ts > applyCoupon > TestApplyCoupon rejects an expired coupon\nAssertionError: expected 200 to be 400\n ❯ src/coupon.test.ts:88:5\n\n Test Files  1 failed | 6 passed (7)\n      Tests  1 failed | 41 passed (42)\n`, { isError: true })
    .say('One failure: an expired coupon is accepted. Looking at the coupon module.')
    .call('Glob', { pattern: 'packages/checkout/src/**/*.ts' }, lines(14, (i) => `packages/checkout/src/${['coupon', 'cart', 'pricing', 'tax', 'shipping', 'index', 'types', 'coupon.test', 'cart.test', 'pricing.test', 'tax.test', 'shipping.test', 'fixtures', 'utils'][i - 1]}.ts`))
    .call('Read', { file_path: 'packages/checkout/src/coupon.ts' }, tsFile('coupon', ['applyCoupon', 'validateCoupon', 'couponDiscount'], `// coupon.ts\n// expiresAt is stored in milliseconds since 2024-03\n`) + `\nexport function isExpired(coupon: Coupon, now = Date.now()): boolean {\n  return coupon.expiresAt < Math.floor(now / 1000);\n}\n`)
    .say('`isExpired` compares `expiresAt` in milliseconds with a timestamp in seconds, so coupons never look expired. Checking the fixture and the test to confirm the units.')
    .call('Read', { file_path: 'packages/checkout/src/fixtures.ts' }, `export const expiredCoupon = {\n  code: 'SPRING24',\n  expiresAt: 1711929600000, // 2024-04-01 in ms\n  percentOff: 15,\n};\nexport const validCoupon = {\n  code: 'WELCOME',\n  expiresAt: 4102444800000,\n  percentOff: 10,\n};\n`)
    .call('Grep', { pattern: 'expiresAt', path: 'packages/checkout/src' }, `packages/checkout/src/coupon.ts:4: // expiresAt is stored in milliseconds since 2024-03\npackages/checkout/src/coupon.ts:41:  return coupon.expiresAt < Math.floor(now / 1000);\npackages/checkout/src/fixtures.ts:3:  expiresAt: 1711929600000, // 2024-04-01 in ms\npackages/checkout/src/fixtures.ts:8:  expiresAt: 4102444800000,\npackages/checkout/src/types.ts:12:  expiresAt: number;\n`)
    .call('Read', { file_path: 'packages/legacy/coupons.js' }, `// legacy coupon engine, kept for the old storefront\n${lines(60, (i) => `module.exports.rule${i} = function (c) { return c.expires < Date.now() / 1000; };`)}`)
    .say('The legacy engine also uses seconds, but the user asked not to touch it and the new module documents milliseconds, so the fix is in `isExpired`.')
    .call('Edit', { file_path: 'packages/checkout/src/coupon.ts', old_string: '  return coupon.expiresAt < Math.floor(now / 1000);', new_string: '  return coupon.expiresAt < now;' }, 'The file packages/checkout/src/coupon.ts has been updated.')
    .call('Bash', { command: 'pnpm test --filter checkout' }, `> checkout@2.4.1 test\n> vitest run\n\n ✓ src/coupon.test.ts (12)\n ✓ src/cart.test.ts (9)\n ✓ src/pricing.test.ts (8)\n ✓ src/tax.test.ts (5)\n ✓ src/shipping.test.ts (4)\n ✓ src/index.test.ts (3)\n ✓ src/utils.test.ts (1)\n\n Test Files  7 passed (7)\n      Tests  42 passed (42)\n`)
    .say('All 42 checkout tests pass. Running the whole workspace to be safe.')
    .call('Bash', { command: 'pnpm test' }, lines(9, (i) => ` ✓ packages/${['checkout', 'cart-ui', 'api', 'auth', 'billing', 'search', 'legacy', 'shared', 'cli'][i - 1]} (${20 + i * 3} tests)`) + `\n\n Test Files  9 passed (9)\n      Tests  247 passed (247)\n`)
    .call('Bash', { command: 'git diff --stat' }, ` packages/checkout/src/coupon.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n`)
    .say('Fixed: `isExpired` compared a millisecond timestamp against seconds, so no coupon ever expired. One-line change in `packages/checkout/src/coupon.ts`; the full suite passes (247 tests). packages/legacy/ untouched.')
    .user('Great. Add a regression test that pins the units, then open a PR.')
    .call('Read', { file_path: 'packages/checkout/src/coupon.test.ts' }, lines(30, (i) => i === 88 % 30 ? "  it('rejects an expired coupon', () => { expect(applyCoupon(cart, expiredCoupon).status).toBe(400); });" : `  // test line ${i}`))
    .call('Edit', { file_path: 'packages/checkout/src/coupon.test.ts', old_string: '  // test line 30', new_string: "  it('treats expiresAt as milliseconds', () => {\n    expect(isExpired({ ...validCoupon, expiresAt: Date.now() - 1 })).toBe(true);\n    expect(isExpired({ ...validCoupon, expiresAt: Date.now() + 60_000 })).toBe(false);\n  });" }, 'The file packages/checkout/src/coupon.test.ts has been updated.')
    .call('Bash', { command: 'pnpm test --filter checkout' }, ` ✓ src/coupon.test.ts (13)\n\n Test Files  7 passed (7)\n      Tests  43 passed (43)\n`)
    .call('Bash', { command: 'git checkout -b fix/coupon-expiry-units && git commit -am "checkout: compare coupon expiry in milliseconds" && gh pr create --fill' }, `Switched to a new branch 'fix/coupon-expiry-units'\n[fix/coupon-expiry-units 4f2a9c1] checkout: compare coupon expiry in milliseconds\n 2 files changed, 5 insertions(+), 1 deletion(-)\nhttps://github.com/acme/storefront/pull/1187\n`)
    .say('Regression test added and PR opened: https://github.com/acme/storefront/pull/1187.')
    .user('Thanks. While CI runs, what would it take to move the legacy engine to milliseconds too?');
  return s.messages;
}

function incident(): Message[] {
  const s = new Session();
  const pods = ['api-7d9f8c-x2k4p', 'api-7d9f8c-m8q2z', 'api-7d9f8c-r4t7n', 'worker-5b6c7-a1b2c', 'worker-5b6c7-d3e4f'];
  s.user('Production API latency p99 jumped from 300ms to 4s at 09:12 UTC. Find out why. You have read access to the cluster; do not restart anything without asking.')
    .say('Starting with the pods and their recent restarts.')
    .call('Bash', { command: 'kubectl get pods -n prod -o wide' }, lines(5, (i) => `${pods[i - 1]}   1/1   Running   ${i === 2 ? 3 : 0}   ${i === 2 ? '11m' : '6d'}   10.0.${i}.${20 + i}   node-${i}`))
    .say('`api-7d9f8c-m8q2z` restarted 3 times in the last 11 minutes. Looking at its previous logs.')
    .call('Bash', { command: 'kubectl logs -n prod api-7d9f8c-m8q2z --previous --tail=200' }, lines(60, (i) => i % 15 === 0 ? `2026-09-20T09:1${Math.floor(i / 15)}:2${i % 10}Z ERROR pg: connection pool exhausted (max 20), 47 waiting, query="SELECT * FROM orders WHERE customer_id = $1 AND created_at > $2"` : `2026-09-20T09:1${Math.floor(i / 15)}:${String(i % 60).padStart(2, '0')}Z INFO request_id=req_${1000 + i} path=/v2/orders status=200 ms=${i * 40}`) + `\nfatal error: out of memory\n`, { isError: true })
    .call('Bash', { command: 'kubectl describe pod -n prod api-7d9f8c-m8q2z | grep -A5 "Last State"' }, `    Last State:     Terminated\n      Reason:       OOMKilled\n      Exit Code:    137\n      Started:      Sat, 20 Sep 2026 09:13:41 +0000\n      Finished:     Sat, 20 Sep 2026 09:19:02 +0000\n`)
    .say('OOMKilled, with the Postgres pool exhausted right before. The waiting queries are all the same orders lookup. Checking whether a deploy or a data change coincides with 09:12.')
    .call('Bash', { command: 'kubectl rollout history deployment/api -n prod' }, `REVISION  CHANGE-CAUSE\n41        release 2026.09.18-2\n42        release 2026.09.20-1\n`)
    .call('Bash', { command: 'kubectl rollout history deployment/api -n prod --revision=42 | grep -i image' }, `    Image:      registry.acme.io/api:2026.09.20-1\n`)
    .call('Bash', { command: 'git log --since="2026-09-19" --oneline -- services/api/src/orders' }, `e81c0d4 orders: include line items in customer order list\n2b7a91f orders: add created_at index hint\n`)
    .call('Read', { file_path: 'services/api/src/orders/list.ts' }, `export async function listCustomerOrders(db: Db, customerId: string, since: Date) {\n  const orders = await db.query('SELECT * FROM orders WHERE customer_id = $1 AND created_at > $2', [customerId, since]);\n  // e81c0d4: attach line items\n  for (const order of orders) {\n    order.items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);\n  }\n  return orders;\n}\n`)
    .say('Commit e81c0d4 added an N+1: one query per order for line items, holding a pooled connection for each. Customers with many orders exhaust the pool and the response objects grow until the pod is OOM killed. Checking how bad the fan-out is.')
    .call('Bash', { command: "psql $PROD_RO -c \"SELECT customer_id, count(*) FROM orders WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 5\"" }, ` customer_id | count\n-------------+-------\n cus_8f1e2d  | 18422\n cus_44a0c1  |  9310\n cus_c9b7e0  |  7755\n cus_1d2e3f  |  6120\n cus_a0b1c2  |  5904\n(5 rows)\n`)
    .call('Bash', { command: 'kubectl top pods -n prod' }, lines(5, (i) => `${pods[i - 1]}   ${i === 2 ? '1980m' : '210m'}   ${i === 2 ? '3910Mi' : '620Mi'}`))
    .say('Confirmed: a wholesale customer with 18k orders in 30 days triggers 18k line-item queries per request. The pod at 3.9Gi is about to be killed again.')
    .call('Bash', { command: 'kubectl get hpa -n prod' }, `NAME   REFERENCE        TARGETS    MINPODS   MAXPODS   REPLICAS\napi    Deployment/api   88%/60%    3         6         3\n`)
    .call('Bash', { command: 'kubectl scale deployment/api -n prod --replicas=6' }, `Error from server (Forbidden): deployments.apps "api" is forbidden: User "reader" cannot patch resource "deployments/scale"\n`, { isError: true })
    .say('I only have read access, as expected. Summary of the cause: release 2026.09.20-1 (commit e81c0d4) introduced an N+1 line-items query in `listCustomerOrders`; wholesale customers with tens of thousands of orders exhaust the Postgres pool (max 20) and grow responses until the API pods are OOM killed (exit 137). Options: roll back to revision 41, or hotfix with a single joined query. I recommend the rollback now and the fix behind it.')
    .user('Roll back. I have granted you deploy rights for the next hour.')
    .call('Bash', { command: 'kubectl rollout undo deployment/api -n prod --to-revision=41' }, `deployment.apps/api rolled back\n`)
    .call('Bash', { command: 'kubectl rollout status deployment/api -n prod --timeout=180s' }, `Waiting for deployment "api" rollout to finish: 1 of 3 updated replicas are available...\nWaiting for deployment "api" rollout to finish: 2 of 3 updated replicas are available...\ndeployment "api" successfully rolled out\n`)
    .call('Bash', { command: 'curl -s https://metrics.acme.io/api/v1/query?query=histogram_quantile(0.99,rate(http_request_duration_seconds_bucket{service="api"}[2m]))' }, `{"status":"success","data":{"result":[{"metric":{},"value":[1789894240,"0.287"]}]}}\n`)
    .say('Rolled back to revision 41; p99 is back to 287ms. Next: rewrite `listCustomerOrders` to fetch line items in one query and add a pool-wait alert.')
    .user('Write up the incident for the postmortem doc, then start on the joined-query fix.');
  return s.messages;
}

function research(): Message[] {
  const s = new Session();
  const page = (title: string, n: number) => `# ${title}\n\n${lines(n, (i) => `Paragraph ${i}: ${title} discusses rate limiting, retry budgets, idempotency keys, and the trade-offs between token buckets and sliding windows in distributed gateways. Sentence ${i} elaborates with an example involving ${i * 37} requests per second and a burst of ${i * 5}.`)}`;
  s.user('We need to pick a rate limiting approach for the public API gateway (Go, behind Envoy). Compare token bucket vs sliding window log vs sliding window counter, and recommend one with a sketch of the config. Keep the memory per client under 100 bytes.')
    .say('I will read the standard references first.')
    .call('WebSearch', { query: 'sliding window counter rate limiting memory per key' }, lines(10, (i) => `${i}. https://example.org/rate-limiting/${['token-bucket', 'sliding-log', 'sliding-counter', 'envoy-local-ratelimit', 'redis-cell', 'gcra', 'leaky-bucket', 'cloudflare-counters', 'stripe-limiters', 'kong-plugin'][i - 1]} — ${['Token bucket explained', 'Sliding window log', 'Sliding window counter', 'Envoy local rate limit filter', 'redis-cell GCRA module', 'GCRA algorithm', 'Leaky bucket', 'How Cloudflare counts', 'Scaling Stripe rate limiters', 'Kong rate limiting'][i - 1]}`))
    .call('WebFetch', { url: 'https://example.org/rate-limiting/token-bucket' }, page('Token bucket explained', 40))
    .call('WebFetch', { url: 'https://example.org/rate-limiting/sliding-log' }, page('Sliding window log', 35))
    .call('WebFetch', { url: 'https://example.org/rate-limiting/sliding-counter' }, page('Sliding window counter', 45) + '\n\nMemory: two integers per key (current and previous window counts) plus a timestamp: 24 bytes.')
    .say('Sliding window counter needs two counters and a timestamp per key, about 24 bytes, which fits the 100-byte budget; the log needs one entry per request and does not.')
    .call('WebFetch', { url: 'https://example.org/rate-limiting/envoy-local-ratelimit' }, page('Envoy local rate limit filter', 30) + '\n\n```yaml\ntoken_bucket:\n  max_tokens: 1000\n  tokens_per_fill: 100\n  fill_interval: 1s\n```')
    .call('WebFetch', { url: 'https://example.org/rate-limiting/gcra' }, page('GCRA algorithm', 50) + '\n\nGCRA stores a single timestamp (the theoretical arrival time) per key: 8 bytes.')
    .say('GCRA is the most compact: one timestamp per key, and it behaves like a token bucket with smooth refill.')
    .call('Read', { file_path: 'gateway/internal/limits/limiter.go' }, `package limits\n\n${lines(40, (i) => i === 12 ? 'type Limiter interface { Allow(key string, now time.Time) bool }' : `// line ${i} of the current limiter scaffold`)}`)
    .call('Grep', { pattern: 'Allow(', path: 'gateway/' }, `gateway/internal/limits/limiter.go:12: type Limiter interface { Allow(key string, now time.Time) bool }\ngateway/internal/handler/auth.go:88:   if !limiter.Allow(clientID, time.Now()) {\ngateway/internal/handler/webhooks.go:41:  if !limiter.Allow(tenant, now) {\n`)
    .call('Bash', { command: 'go test ./gateway/internal/limits/... -bench . -benchmem' }, `goos: linux\nBenchmarkTokenBucket-8        20000000   61 ns/op   0 B/op\nBenchmarkSlidingCounter-8     15000000   84 ns/op   0 B/op\nBenchmarkSlidingLog-8           500000  2410 ns/op  96 B/op\nPASS\n`)
    .say('Recommendation: GCRA (a token bucket expressed as one timestamp per key), 8 bytes per client, 61ns per decision in the benchmark, and it maps onto Envoy\'s local rate limit filter for the edge tier. Sliding window log is out on memory (one entry per request); sliding window counter is a fine fallback at 24 bytes but has the well-known burst-at-boundary approximation.\n\nSketch:\n\n```go\ntype gcra struct{ tat sync.Map } // key -> theoretical arrival time (int64 ns)\nfunc (g *gcra) Allow(key string, now time.Time) bool { /* rate 100/s, burst 50 */ }\n```\n\nEnvoy edge tier: `token_bucket: {max_tokens: 1000, tokens_per_fill: 100, fill_interval: 1s}`.')
    .user('Go with GCRA. Implement it behind the Limiter interface with tests, 100 rps and burst 50 by default.')
    .call('Write', { file_path: 'gateway/internal/limits/gcra.go', content: `package limits\n\n${lines(45, (i) => `// gcra implementation line ${i}`)}` }, 'Wrote gateway/internal/limits/gcra.go (47 lines).')
    .call('Write', { file_path: 'gateway/internal/limits/gcra_test.go', content: `package limits\n\n${lines(30, (i) => `// gcra test line ${i}`)}` }, 'Wrote gateway/internal/limits/gcra_test.go (32 lines).')
    .call('Bash', { command: 'go test ./gateway/internal/limits/...' }, `ok  \tgateway/internal/limits\t0.412s\n`)
    .say('GCRA limiter implemented behind `Limiter`, defaults 100 rps and burst 50, tests pass.')
    .user('Now wire it into the auth handler and add a metric for rejected requests.');
  return s.messages;
}

function longRefactor(): Message[] {
  const s = new Session();
  const modules = ['users', 'billing', 'invoices', 'subscriptions', 'webhooks', 'audit', 'notifications', 'reports', 'exports', 'imports', 'search', 'tags', 'teams', 'roles', 'sessions', 'tokens', 'files', 'comments', 'labels', 'settings'];
  s.user('Migrate every service module under src/services/ from the callback-style `db.query(sql, params, cb)` to the promise-based `db.run(sql, params)`. Keep behavior identical, run the module tests after each one, and stop if anything fails. There are about 20 modules.')
    .say('I will go module by module: read, edit, test.');
  for (const [k, mod] of modules.entries()) {
    const file = `src/services/${mod}.ts`;
    s.call('Read', { file_path: file }, `// ${mod} service\n${lines(50 + (k % 5) * 10, (i) => i % 9 === 0 ? `  db.query('SELECT * FROM ${mod} WHERE id = $1', [id], (err, rows) => { if (err) return cb(err); cb(null, rows[0]); });` : `  // ${mod} logic line ${i}`)}`, { text: k === 0 ? '' : `${modules[k - 1]} done. Next: ${mod}.` })
      .call('Grep', { pattern: 'db\\.query\\(', path: file }, lines(3 + (k % 4), (i) => `${file}:${9 * i}:  db.query('SELECT * FROM ${mod} WHERE id = $1', [id], (err, rows) => { if (err) return cb(err); cb(null, rows[0]); });`))
      .call('Edit', { file_path: file, old_string: `db.query('SELECT * FROM ${mod} WHERE id = $1', [id], (err, rows) => { if (err) return cb(err); cb(null, rows[0]); });`, new_string: `const rows = await db.run('SELECT * FROM ${mod} WHERE id = $1', [id]); return rows[0];`, replace_all: true }, `The file ${file} has been updated (${3 + (k % 4)} replacements).`);
    if (k === 7) {
      s.call('Bash', { command: `pnpm vitest run src/services/${mod}.test.ts` }, ` FAIL  src/services/${mod}.test.ts > ${mod} > lists reports for a team\nTypeError: Cannot read properties of undefined (reading 'length')\n ❯ src/services/${mod}.ts:63:21\n\n Tests  1 failed | 11 passed (12)\n`, { isError: true })
        .say('`listReports` used the callback\'s second argument as the whole rows array; the promise form returns rows directly. Fixing that call site.')
        .call('Edit', { file_path: file, old_string: 'const rows = await db.run(sql, [teamId]); return rows[0];', new_string: 'const rows = await db.run(sql, [teamId]); return rows;' }, `The file ${file} has been updated.`)
        .call('Bash', { command: `pnpm vitest run src/services/${mod}.test.ts` }, ` ✓ src/services/${mod}.test.ts (12)\n\n Tests  12 passed (12)\n`);
    } else {
      s.call('Bash', { command: `pnpm vitest run src/services/${mod}.test.ts` }, ` ✓ src/services/${mod}.test.ts (${8 + (k % 6)})\n\n Tests  ${8 + (k % 6)} passed (${8 + (k % 6)})\n`);
    }
    if (k % 6 === 5) s.user(`Progress check: how many modules are left, and any surprises so far?`).say(`${modules.length - k - 1} left. One surprise in reports: a call site returned rows[0] where the whole array was expected; fixed and covered by its test.`);
  }
  s.call('Bash', { command: 'pnpm vitest run' }, lines(20, (i) => ` ✓ src/services/${modules[i - 1]}.test.ts (${8 + ((i - 1) % 6)})`) + `\n\n Test Files  20 passed (20)\n      Tests  212 passed (212)\n`)
    .call('Bash', { command: 'git diff --stat | tail -1' }, ` 20 files changed, 214 insertions(+), 236 deletions(-)\n`)
    .say('All 20 modules migrated to `db.run`; the full suite passes (212 tests). One behavioral fix along the way in reports (`listReports` now returns the array). Ready to commit.')
    .user('Commit it as one change per module so the history stays bisectable, then open the PR.');
  return s.messages;
}

const samples: Record<string, () => Message[]> = {
  'bugfix-checkout': bugfix,
  'incident-api-latency': incident,
  'research-rate-limiting': research,
  'long-refactor-db-layer': longRefactor,
};

await mkdir(OUT, { recursive: true });
for (const [name, make] of Object.entries(samples)) {
  const messages = make();
  await writeFile(path.join(OUT, `${name}.json`), JSON.stringify(messages, null, 1));
  const calls = messages.reduce((n, m) => n + m.toolUses.length, 0);
  const chars = messages.reduce((n, m) => n + m.text.length + m.toolUses.reduce((a, t) => a + JSON.stringify(t.input).length, 0) + (m.toolResults ?? []).reduce((a, r) => a + r.text.length, 0), 0);
  console.log(`${name}: ${messages.length} messages, ${calls} tool calls, ${chars} chars`);
}
