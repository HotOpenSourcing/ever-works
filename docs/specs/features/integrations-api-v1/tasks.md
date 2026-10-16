# Task Breakdown: Integration API v1

**Feature ID**: `integrations-api-v1`
**Last updated**: 2026-10-15

## Contract (published)

- [x] **T0** Machine-readable contract v1 in [`contract/`](./contract/README.md): common, error, envelope, catalog, P1
      DTOs, request bodies, examples, webhook signature vectors (+ generator).

## Phase 1 — Namespace and common pieces (EW-P1-4)

- [ ] **T1** `integrations-api/v1` module skeleton + namespace exception filter (error envelope).
- [ ] **T2** Keyset list helper (`updatedSince`, `(updatedAt, id)` cursor, `limit ≤ 500`) + `(organizationId, updatedAt)`
      indexes.
- [ ] **T3** `ETag` / `If-Match` interceptor.
- [ ] **T4** `idempotency_keys` table + migration (3 dialects) + interceptor + purge job.
- [ ] **T5** `external_record_links` table + migration (3 dialects) + `externalRef` create helper.
- [ ] **T6** `X-Sync-Origin` → event `originTag`.
- [ ] **T7** `POST /batch`.
- [ ] **T8** DTO mappers shared with domain-event `data` builders.

## Phase 2 — P1 resources

- [ ] **T9** `whoami`, `organization`, `members`.
- [ ] **T10** `GET /events` (feed).
- [ ] **T11** Agents (read).
- [ ] **T12** Teams + members + resources.
- [ ] **T13** Works (read).
- [ ] **T14** Tasks + PUT sets.
- [ ] **T15** Task comments.
- [ ] **T16** Links.
- [ ] **T17** OpenAPI in production for the namespace.

## Phase 3 — Webhooks v2 (EW-P1-5)

- [ ] **T18** Subscription columns + migration (3 dialects).
- [ ] **T19** Relay-driven, org-scoped fan-out with `excludeOriginTags`.
- [ ] **T20** `t=,v1=` signer + rotation grace + vector contract test.
- [ ] **T21** PATCH resume; revoke key → disable subscriptions.
- [ ] **T22** Settings → Webhooks UI.

## Phase 4 — Transitions (EW-P1-6)

- [x] **T23** Sync transition path-walk + `409 transition_blocked` (EW-P1-6: `TaskTransitionService.transitionSync` on `POST /api/tasks/:id/transition {to, mode:'sync'}`; the `/integrations/v1` route delegates to it in EW-P1-4).
- [ ] **T24** `cancelled → backlog | todo` reopen (+ web board).

## Phase 5 — Tests (EW-P1-8)

- [ ] **T25** Contract test suite over `contract/`.
- [ ] **T26** Idempotency / `If-Match` / act-as tests.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
