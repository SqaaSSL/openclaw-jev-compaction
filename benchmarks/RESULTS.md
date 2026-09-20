# Benchmark results

Generated 2026-09-20 by `benchmarks/run.ts` against live `jev-latest`, with `preserveRecentMessages: 4`. Samples are the synthetic sessions in `benchmarks/samples/` (see `make-samples.ts`); regenerate them and rerun to reproduce. Jev's scores vary a little between runs (spread about 0.03), so counts can differ by one or two.

Configurations:

- **default**: this project, defaults
- **recoverable**: original question wording, one 0.5 threshold, no excerpts, no rules
- **drop-all**: every answer 0: what an engine without judgment would do

"Needed later" is a rough proxy: a dropped or truncated result whose distinctive tokens (paths, numbers, error lines) reappear in later assistant text or tool inputs. It overcounts coincidences and misses paraphrase.

## Summary

| Sample | Config | Msgs | ~Tokens | Scored | Kept | Truncated | Dropped | Protected | Reduction | ~Tokens after | Needed-later lost | State | Requests | ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| bugfix-checkout | default | 38 | 3967 | 10 | 3 | 0 | 7 | 3 | 56.3% | 1532 | 1/1 | full | 1 | 1454 |
| bugfix-checkout | recoverable | 38 | 3967 | 12 | 0 | 0 | 12 | 1 | 84.9% | 499 | 1/1 | full (no keep signal) | 1 | 1243 |
| bugfix-checkout | drop-all | 38 | 3967 | 10 | 0 | 0 | 10 | 3 | 79.8% | 724 | 1/1 | full (no keep signal) | 1 | 3 |
| incident-api-latency | default | 38 | 3741 | 11 | 1 | 2 | 8 | 2 | 18.1% | 3082 | 0/0 | full | 1 | 400 |
| incident-api-latency | recoverable | 38 | 3741 | 11 | 0 | 1 | 10 | 2 | 22.2% | 2960 | 0/0 | full | 1 | 367 |
| incident-api-latency | drop-all | 38 | 3741 | 11 | 0 | 0 | 11 | 2 | 26.6% | 2828 | 0/0 | full (no keep signal) | 1 | 3 |
| long-refactor-db-layer | default | 179 | 25954 | 61 | 1 | 1 | 59 | 22 | 81.7% | 4834 | 0/0 | full | 1 | 1085 |
| long-refactor-db-layer | recoverable | 179 | 25954 | 82 | 0 | 0 | 82 | 1 | 94% | 1228 | 0/0 | full (no keep signal) | 1 | 724 |
| long-refactor-db-layer | drop-all | 179 | 25954 | 61 | 0 | 0 | 61 | 22 | 84.6% | 4107 | 0/0 | full (no keep signal) | 1 | 3 |
| research-rate-limiting | default | 32 | 15371 | 9 | 2 | 0 | 7 | 2 | 90.4% | 1792 | 1/1 | full | 1 | 415 |
| research-rate-limiting | recoverable | 32 | 15371 | 11 | 0 | 0 | 11 | 0 | 97.5% | 422 | 1/1 | full (no keep signal) | 1 | 372 |
| research-rate-limiting | drop-all | 32 | 15371 | 9 | 0 | 0 | 9 | 2 | 93.7% | 1184 | 1/1 | full (no keep signal) | 1 | 1 |

## Decisions, default configuration

### bugfix-checkout

| Call | Tool | Input | Action | Why | keepCall | keepResult |
| --- | --- | --- | --- | --- | ---: | ---: |
| t1 | Bash | command=pnpm test --filter checkout | keep | protected: error |  |  |
| t2 | Glob | pattern=packages/checkout/src/**/*.ts | drop_call | call_dropped | 0.12 | 0.10 |
| t3 | Read | file_path=packages/checkout/src/coupon.ts | keep | kept | 0.45 | 0.40 |
| t4 | Read | file_path=packages/checkout/src/fixtures.ts | keep | kept | 0.30 | 0.33 |
| t5 | Grep | pattern=expiresAt | drop_call | call_dropped | 0.16 | 0.14 |
| t6 | Read | file_path=packages/legacy/coupons.js | drop_call | call_dropped | 0.27 | 0.22 |
| t7 | Edit | file_path=packages/checkout/src/coupon.ts | keep | protected: edit |  |  |
| t8 | Bash | command=pnpm test --filter checkout | drop_call | call_dropped | 0.34 | 0.08 |
| t9 | Bash | command=pnpm test | drop_call | call_dropped | 0.29 | 0.08 |
| t10 | Bash | command=git diff --stat | drop_call | call_dropped | 0.19 | 0.09 |
| t11 | Read | file_path=packages/checkout/src/coupon.test.ts | keep | kept | 0.44 | 0.58 |
| t12 | Edit | file_path=packages/checkout/src/coupon.test.ts | keep | protected: edit |  |  |
| t13 | Bash | command=pnpm test --filter checkout | drop_call | call_dropped | 0.33 | 0.08 |
| t14 | Bash | command=git checkout -b fix/coupon-expiry-units && git … | keep | pinned |  |  |

### incident-api-latency

| Call | Tool | Input | Action | Why | keepCall | keepResult |
| --- | --- | --- | --- | --- | ---: | ---: |
| t1 | Bash | command=kubectl get pods -n prod -o wide | drop_call | call_dropped | 0.24 | 0.13 |
| t2 | Bash | command=kubectl logs -n prod api-7d9f8c-m8q2z --previou… | keep | protected: error |  |  |
| t3 | Bash | command=kubectl describe pod -n prod api-7d9f8c-m8q2z \|… | drop_call | call_dropped | 0.34 | 0.15 |
| t4 | Bash | command=kubectl rollout history deployment/api -n prod | drop_call | call_dropped | 0.38 | 0.21 |
| t5 | Bash | command=kubectl rollout history deployment/api -n prod … | drop_call | call_dropped | 0.23 | 0.14 |
| t6 | Bash | command=git log --since="2026-09-19" --oneline -- servi… | drop_call | call_dropped | 0.31 | 0.24 |
| t7 | Read | file_path=services/api/src/orders/list.ts | keep | kept | 0.65 | 0.55 |
| t8 | Bash | command=psql $PROD_RO -c "SELECT customer_id, count(*) … | drop_call | call_dropped | 0.41 | 0.19 |
| t9 | Bash | command=kubectl top pods -n prod | drop_call | call_dropped | 0.28 | 0.16 |
| t10 | Bash | command=kubectl get hpa -n prod | drop_call | call_dropped | 0.23 | 0.17 |
| t11 | Bash | command=kubectl scale deployment/api -n prod --replicas… | keep | protected: error |  |  |
| t12 | Bash | command=kubectl rollout undo deployment/api -n prod --t… | drop_result | result_dropped | 0.83 | 0.09 |
| t13 | Bash | command=kubectl rollout status deployment/api -n prod -… | drop_result | result_dropped | 0.57 | 0.09 |
| t14 | Bash | command=curl -s https://metrics.acme.io/api/v1/query?qu… | keep | pinned |  |  |

### long-refactor-db-layer

| Call | Tool | Input | Action | Why | keepCall | keepResult |
| --- | --- | --- | --- | --- | ---: | ---: |
| t1 | Read | file_path=src/services/users.ts | drop_call | call_dropped | 0.14 | 0.12 |
| t2 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.12 | 0.13 |
| t3 | Edit | file_path=src/services/users.ts | keep | protected: edit |  |  |
| t4 | Bash | command=pnpm vitest run src/services/users.test.ts | drop_call | call_dropped | 0.36 | 0.06 |
| t5 | Read | file_path=src/services/billing.ts | drop_call | call_dropped | 0.15 | 0.13 |
| t6 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.13 | 0.15 |
| t7 | Edit | file_path=src/services/billing.ts | keep | protected: edit |  |  |
| t8 | Bash | command=pnpm vitest run src/services/billing.test.ts | drop_call | call_dropped | 0.36 | 0.06 |
| t9 | Read | file_path=src/services/invoices.ts | drop_call | call_dropped | 0.14 | 0.21 |
| t10 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.11 | 0.17 |
| t11 | Edit | file_path=src/services/invoices.ts | keep | protected: edit |  |  |
| t12 | Bash | command=pnpm vitest run src/services/invoices.test.ts | drop_call | call_dropped | 0.31 | 0.06 |
| t13 | Read | file_path=src/services/subscriptions.ts | drop_call | call_dropped | 0.15 | 0.16 |
| t14 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.12 | 0.15 |
| t15 | Edit | file_path=src/services/subscriptions.ts | keep | protected: edit |  |  |
| t16 | Bash | command=pnpm vitest run src/services/subscriptions.test… | drop_call | call_dropped | 0.34 | 0.06 |
| t17 | Read | file_path=src/services/webhooks.ts | drop_call | call_dropped | 0.13 | 0.16 |
| t18 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.10 | 0.16 |
| t19 | Edit | file_path=src/services/webhooks.ts | keep | protected: edit |  |  |
| t20 | Bash | command=pnpm vitest run src/services/webhooks.test.ts | drop_call | call_dropped | 0.32 | 0.05 |
| t21 | Read | file_path=src/services/audit.ts | drop_call | call_dropped | 0.14 | 0.13 |
| t22 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.10 | 0.13 |
| t23 | Edit | file_path=src/services/audit.ts | keep | protected: edit |  |  |
| t24 | Bash | command=pnpm vitest run src/services/audit.test.ts | drop_call | call_dropped | 0.31 | 0.06 |
| t25 | Read | file_path=src/services/notifications.ts | drop_call | call_dropped | 0.16 | 0.20 |
| t26 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.12 | 0.16 |
| t27 | Edit | file_path=src/services/notifications.ts | keep | protected: edit |  |  |
| t28 | Bash | command=pnpm vitest run src/services/notifications.test… | drop_call | call_dropped | 0.22 | 0.06 |
| t29 | Read | file_path=src/services/reports.ts | drop_call | call_dropped | 0.14 | 0.15 |
| t30 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.13 | 0.16 |
| t31 | Edit | file_path=src/services/reports.ts | keep | protected: edit |  |  |
| t32 | Bash | command=pnpm vitest run src/services/reports.test.ts | keep | protected: error |  |  |
| t33 | Edit | file_path=src/services/reports.ts | keep | protected: edit |  |  |
| t34 | Bash | command=pnpm vitest run src/services/reports.test.ts | drop_call | call_dropped | 0.29 | 0.08 |
| t35 | Read | file_path=src/services/exports.ts | drop_call | call_dropped | 0.16 | 0.17 |
| t36 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.13 | 0.19 |
| t37 | Edit | file_path=src/services/exports.ts | keep | protected: edit |  |  |
| t38 | Bash | command=pnpm vitest run src/services/exports.test.ts | drop_call | call_dropped | 0.31 | 0.06 |
| t39 | Read | file_path=src/services/imports.ts | drop_call | call_dropped | 0.16 | 0.17 |
| t40 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.13 | 0.15 |
| t41 | Edit | file_path=src/services/imports.ts | keep | protected: edit |  |  |
| t42 | Bash | command=pnpm vitest run src/services/imports.test.ts | drop_call | call_dropped | 0.32 | 0.07 |
| t43 | Read | file_path=src/services/search.ts | drop_call | call_dropped | 0.16 | 0.15 |
| t44 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.12 | 0.15 |
| t45 | Edit | file_path=src/services/search.ts | keep | protected: edit |  |  |
| t46 | Bash | command=pnpm vitest run src/services/search.test.ts | drop_call | call_dropped | 0.29 | 0.06 |
| t47 | Read | file_path=src/services/tags.ts | keep | kept | 0.16 | 0.27 |
| t48 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.13 | 0.17 |
| t49 | Edit | file_path=src/services/tags.ts | keep | protected: edit |  |  |
| t50 | Bash | command=pnpm vitest run src/services/tags.test.ts | drop_call | call_dropped | 0.32 | 0.06 |
| t51 | Read | file_path=src/services/teams.ts | drop_call | call_dropped | 0.16 | 0.20 |
| t52 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.12 | 0.15 |
| t53 | Edit | file_path=src/services/teams.ts | keep | protected: edit |  |  |
| t54 | Bash | command=pnpm vitest run src/services/teams.test.ts | drop_call | call_dropped | 0.28 | 0.06 |
| t55 | Read | file_path=src/services/roles.ts | drop_call | call_dropped | 0.18 | 0.24 |
| t56 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.12 | 0.14 |
| t57 | Edit | file_path=src/services/roles.ts | keep | protected: edit |  |  |
| t58 | Bash | command=pnpm vitest run src/services/roles.test.ts | drop_call | call_dropped | 0.25 | 0.06 |
| t59 | Read | file_path=src/services/sessions.ts | drop_call | call_dropped | 0.15 | 0.19 |
| t60 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.11 | 0.14 |
| t61 | Edit | file_path=src/services/sessions.ts | keep | protected: edit |  |  |
| t62 | Bash | command=pnpm vitest run src/services/sessions.test.ts | drop_call | call_dropped | 0.26 | 0.06 |
| t63 | Read | file_path=src/services/tokens.ts | drop_call | call_dropped | 0.16 | 0.15 |
| t64 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.12 | 0.15 |
| t65 | Edit | file_path=src/services/tokens.ts | keep | protected: edit |  |  |
| t66 | Bash | command=pnpm vitest run src/services/tokens.test.ts | drop_call | call_dropped | 0.29 | 0.07 |
| t67 | Read | file_path=src/services/files.ts | drop_call | call_dropped | 0.14 | 0.18 |
| t68 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.13 | 0.16 |
| t69 | Edit | file_path=src/services/files.ts | keep | protected: edit |  |  |
| t70 | Bash | command=pnpm vitest run src/services/files.test.ts | drop_call | call_dropped | 0.27 | 0.06 |
| t71 | Read | file_path=src/services/comments.ts | drop_call | call_dropped | 0.14 | 0.16 |
| t72 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.12 | 0.16 |
| t73 | Edit | file_path=src/services/comments.ts | keep | protected: edit |  |  |
| t74 | Bash | command=pnpm vitest run src/services/comments.test.ts | drop_call | call_dropped | 0.31 | 0.06 |
| t75 | Read | file_path=src/services/labels.ts | drop_call | call_dropped | 0.19 | 0.17 |
| t76 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.13 | 0.20 |
| t77 | Edit | file_path=src/services/labels.ts | keep | protected: edit |  |  |
| t78 | Bash | command=pnpm vitest run src/services/labels.test.ts | drop_call | call_dropped | 0.40 | 0.07 |
| t79 | Read | file_path=src/services/settings.ts | drop_call | call_dropped | 0.22 | 0.19 |
| t80 | Grep | pattern=db\.query\( | drop_call | call_dropped | 0.13 | 0.16 |
| t81 | Edit | file_path=src/services/settings.ts | keep | protected: edit |  |  |
| t82 | Bash | command=pnpm vitest run src/services/settings.test.ts | drop_call | call_dropped | 0.46 | 0.08 |
| t83 | Bash | command=pnpm vitest run | drop_result | result_dropped | 0.63 | 0.10 |
| t84 | Bash | command=git diff --stat \| tail -1 | keep | pinned |  |  |

### research-rate-limiting

| Call | Tool | Input | Action | Why | keepCall | keepResult |
| --- | --- | --- | --- | --- | ---: | ---: |
| t1 | WebSearch | query=sliding window counter rate limiting memory per… | drop_call | call_dropped | 0.10 | 0.10 |
| t2 | WebFetch | url=https://example.org/rate-limiting/token-bucket | drop_call | call_dropped | 0.19 | 0.16 |
| t3 | WebFetch | url=https://example.org/rate-limiting/sliding-log | drop_call | call_dropped | 0.20 | 0.17 |
| t4 | WebFetch | url=https://example.org/rate-limiting/sliding-count… | drop_call | call_dropped | 0.34 | 0.20 |
| t5 | WebFetch | url=https://example.org/rate-limiting/envoy-local-r… | drop_call | call_dropped | 0.20 | 0.21 |
| t6 | WebFetch | url=https://example.org/rate-limiting/gcra | drop_call | call_dropped | 0.46 | 0.23 |
| t7 | Read | file_path=gateway/internal/limits/limiter.go | keep | kept | 0.60 | 0.48 |
| t8 | Grep | pattern=Allow( | keep | kept | 0.39 | 0.38 |
| t9 | Bash | command=go test ./gateway/internal/limits/... -bench . … | drop_call | call_dropped | 0.31 | 0.14 |
| t10 | Write | file_path=gateway/internal/limits/gcra.go | keep | protected: edit |  |  |
| t11 | Write | file_path=gateway/internal/limits/gcra_test.go | keep | protected: edit |  |  |
| t12 | Bash | command=go test ./gateway/internal/limits/... | keep | pinned |  |  |
