# Task Breakdown: Integration API v1

**Feature ID**: `integrations-api-v1`
**Last updated**: 2026-10-16

## Contract (published)

- [x] **T0** Machine-readable contract v1 in [`contract/`](./contract/README.md): common, error, envelope, catalog, P1
      DTOs, request bodies, examples, webhook signature vectors (+ generator).

## Phase 1 — Namespace and common pieces (EW-P1-4)

- [x] **T1** `integrations-api/v1` module (`apps/api/src/integrations-api/v1/`) + `IntegrationExceptionFilter`
      (error envelope; an exception already shaped as the envelope, e.g. `409 transition_blocked`, keeps its code
      and details).
- [x] **T2** Keyset list helper (`updatedSince`, `(updatedAt, id)` cursor, `limit ≤ 500`) — `readKeysetPage` in
      `packages/agent/src/integrations-api/keyset-cursor.ts`; `(organizationId, updatedAt, id)` indexes (and
      `(taskId, updatedAt, id)` for comments) in migration `1795080300000`.
- [x] **T3** `ETag` / `If-Match` — helpers (`etagFor`, `parseIfMatch`, `assertIfMatch` → `412 version_mismatch`),
      applied per write route (PATCH / DELETE of tasks and teams), and re-checked at the version bump inside the
      write's transaction (`runExpectingAggregateVersion`), so of two writers on one version only the first wins.
- [~] **T4** `integration_idempotency_keys` table + migration (3 dialects, `1795080200000`) +
  `IntegrationIdempotencyService` (claim-first, replay, mismatch/in-progress `409`, release on error/5xx, purge);
  `runIdempotent` on every create (`Idempotent-Replayed: true` on a replay). Open: a schedule for `purgeExpired`.
- [x] **T5** `external_record_links` table + migration (3 dialects, `1795080200000`) + `ExternalRecordLinksService`
      (create in the caller's transaction, `PUT`/`DELETE`/list, `linksFor`, `installationFromOrigin`).
- [x] **T6** `X-Sync-Origin` → event `originTag` (`DomainEventContextInterceptor`, EW-P1-1 #2611).
- [x] **T7** `POST /batch` — ≤ 100 operations in order, not atomic; each one a loopback request with the outer
      credential and pin, so every guard, scope and rate limit applies; paths confined to `/api/integrations/v1`.
- [x] **T8** DTO mappers shared with domain-event `data` builders (`domain-event-snapshots.ts`, EW-P1-1 #2617).

## Phase 2 — P1 resources

- [x] **T9** `whoami` (EW-P1-2), `organization`, `members`.
- [x] **T10** `GET /events` (feed).
- [x] **T11** Agents (read).
- [x] **T12** Teams: `GET`/`POST /teams`, `GET`/`PATCH`/`DELETE /teams/:id`, `PUT /teams/:id/members` (a role change is
      a remove + an add), `PUT /teams/:id/resources`.
- [x] **T13** Works (read).
- [x] **T14** Tasks: reads, `POST` (Idempotency-Key, `externalRef`, status `backlog`\|`todo`, `private` → `422`),
      `PATCH`/`DELETE` with `If-Match`, `POST /tasks/:id/transition {to, mode:'sync'}` (delegates to
      `TasksService.syncTransition`, never `force`), `PUT` assignees / watchers / blocks / relations.
- [x] **T15** Task comments: `GET`/`POST /tasks/:id/comments`, `PATCH`/`DELETE /tasks/:id/comments/:cid` (author only;
      integration-authored: no edit window; refusals `422 domain_rule`; `task.comment.deleted`).
- [x] **T16** Links: `GET /links`, `PUT`/`DELETE /links/:entityType/:entityId` (the record must be visible; types not
      served in v1 yet → `400`).
- [x] **T17** OpenAPI in production: `GET /api/integrations/v1/openapi.json` (`serveIntegrationOpenApi`).
- [ ] **T17a** One transaction per request: create + link, and every edge of a `PUT` set or of a create's assignees /
      extra teams. Today each step commits on its own (create, then link, undone on a lost race; a `PUT` set that fails
      half-way keeps the steps before the failure); a crash between create and link leaves an unlinked record.
- [ ] **T17b** OpenAPI request/response bodies (`@ApiProperty` or the Swagger CLI plugin under SWC); today the document
      lists every route, scope and summary, and the bodies are the contract JSON Schemas.
- [x] **T17c** Task `visibility` writes (`team` / `organization`, `visibilityExplicit`) through
      `RecordVisibilityService.setVisibility` (EW-P1-3, #2621); `private` → `422`. Reads hide a row whose STORED
      visibility is `private`.

## Phase 3 — Webhooks v2 (EW-P1-5)

- [x] **T18** Subscription columns + migration (3 dialects) — `1795080100000-AddWebhookSubscriptionsV2`.
- [x] **T19** Relay-driven, org-scoped fan-out with `excludeOriginTags` — `WebhookDomainEventFanoutService` (cursor
      `core:webhooks-v2`, at least once, idempotent per `(subscription, event)`).
- [x] **T20** `t=,v1=` signer + rotation grace + vector contract test — `webhook-signature-v2.ts` (all 22 vectors).
- [x] **T21** PATCH resume; key-owned subscriptions at `/api/integrations/v1/webhooks` (`webhooks:manage`: list /
      create / PATCH / rotate-secret / test / delete, only the key's own, only its pinned organizations); revoking the
      key disables them at once (`IntegrationKeyRevokedWebhooksListener`), and the fan-out and the sender re-check the
      owner before each delivery.
- [ ] **T22** Settings → Webhooks UI.

## Phase 4 — Transitions (EW-P1-6)

- [x] **T23** Sync transition path-walk + `409 transition_blocked` (EW-P1-6: `TaskTransitionService.transitionSync` on `POST /api/tasks/:id/transition {to, mode:'sync'}`; the `/integrations/v1` route delegates to it in EW-P1-4).
- [x] **T24** `cancelled → backlog | todo` reopen (+ web board) (EW-P1-6: `TASK_STATUS_TRANSITIONS` / `TASK_BOARD_TRANSITIONS`, Task detail page, Kanban).

## Phase 5 — Tests (EW-P1-8)

- [ ] **T25** Contract test suite over `contract/`.
- [ ] **T26** Idempotency / `If-Match` / act-as tests.

## Phase 6 — Inbox (EW-P3-1)

- [x] **T27** `GET /inbox/items` (every recipient of the pinned organization; `recipientUserId`, `status`, `kind`,
      `includeArchived`, keyset) and `GET /inbox/items/:id` (`ETag`) — `IntegrationInboxService`; keyset index
      `idx_inbox_items_org_updated` (migration `1795130100000`, 3 dialects).
- [x] **T28** `POST /inbox/items/:id/reply` and `PATCH /inbox/items/:id/state`, act-as = the recipient only
      (`403 act_as_forbidden` otherwise), through the app's own `InboxService`; reply answers
      `{item, routed, restart, runId?}`, `Idempotency-Key` optional; state `If-Match` pre-check. Contract CR-4
      (`requests.schema.json` `InboxReply` / `InboxStateChange`, `resources/inbox-reply-result.schema.json`).

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
