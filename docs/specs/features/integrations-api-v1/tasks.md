# Task Breakdown: Integration API v1

**Feature ID**: `integrations-api-v1`
**Last updated**: 2026-10-15

## Contract (published)

- [x] **T0** Machine-readable contract v1 in [`contract/`](./contract/README.md): common, error, envelope, catalog, P1
      DTOs, request bodies, examples, webhook signature vectors (+ generator).

## Phase 1 — Namespace and common pieces (EW-P1-4)

- [ ] **T1** `integrations-api/v1` module skeleton + namespace exception filter (error envelope).
- [~] **T2** Keyset list helper (`updatedSince`, `(updatedAt, id)` cursor, `limit ≤ 500`) — `readKeysetPage` in
  `packages/agent/src/integrations-api/keyset-cursor.ts`; the `(organizationId, updatedAt)` indexes ship with the
  resource routes that read them.
- [~] **T3** `ETag` / `If-Match` — helpers (`etagFor`, `parseIfMatch`, `assertIfMatch` → `VersionMismatchError`); the
  interceptor ships with the write routes.
- [~] **T4** `integration_idempotency_keys` table + migration (3 dialects, `1795080200000`) +
  `IntegrationIdempotencyService` (claim-first, replay, mismatch/in-progress `409`, release on error/5xx, purge);
  the interceptor and purge schedule ship with the write routes.
- [x] **T5** `external_record_links` table + migration (3 dialects, `1795080200000`) + `ExternalRecordLinksService`
      (create in the caller's transaction, `PUT`/`DELETE`/list, `linksFor`, `installationFromOrigin`).
- [x] **T6** `X-Sync-Origin` → event `originTag` (`DomainEventContextInterceptor`, EW-P1-1 #2611).
- [ ] **T7** `POST /batch`.
- [x] **T8** DTO mappers shared with domain-event `data` builders (`domain-event-snapshots.ts`, EW-P1-1 #2617).

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

- [x] **T18** Subscription columns + migration (3 dialects) — `1795080100000-AddWebhookSubscriptionsV2`.
- [x] **T19** Relay-driven, org-scoped fan-out with `excludeOriginTags` — `WebhookDomainEventFanoutService` (cursor
      `core:webhooks-v2`, at least once, idempotent per `(subscription, event)`).
- [x] **T20** `t=,v1=` signer + rotation grace + vector contract test — `webhook-signature-v2.ts` (all 22 vectors).
- [~] **T21** PATCH resume (done); revoke key → disable subscriptions (the fan-out disables them lazily; the
  `/api/integrations/v1/webhooks` routes for key-owned subscriptions follow #2606).
- [ ] **T22** Settings → Webhooks UI.

## Phase 4 — Transitions (EW-P1-6)

- [x] **T23** Sync transition path-walk + `409 transition_blocked` (EW-P1-6: `TaskTransitionService.transitionSync` on `POST /api/tasks/:id/transition {to, mode:'sync'}`; the `/integrations/v1` route delegates to it in EW-P1-4).
- [x] **T24** `cancelled → backlog | todo` reopen (+ web board) (EW-P1-6: `TASK_STATUS_TRANSITIONS` / `TASK_BOARD_TRANSITIONS`, Task detail page, Kanban).

## Phase 5 — Tests (EW-P1-8)

- [ ] **T25** Contract test suite over `contract/`.
- [ ] **T26** Idempotency / `If-Match` / act-as tests.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
