# Implementation Plan: Integration Keys

**Feature ID**: `integration-keys`
**Spec**: [`spec.md`](./spec.md)
**Status**: `Draft`
**Last updated**: 2026-10-15

## Phase 1 — Data model

- **P1.1** `api_keys` columns: `scopes`, `organizationIds`, `integrationKind`, `description`, `rotatedFromKeyId`,
  `previousKeyGraceUntil`; `kind` value `integration`. Migration on Postgres, MySQL, better-sqlite3 with `down`.
- **P1.2** `tasks.createdByType` value `integration`; `task_chat_messages.authorType` value `integration` +
  `externalAuthor` JSON column.

## Phase 2 — Principal

- **P2.1** `ew_int_` prefix in `AuthSessionGuard` → `AuthenticatedUser{authMethod:'integration', …}`.
- **P2.2** Scope resolution: `X-Scope-Slug` / `X-Organization-Id` must be pinned (`403 org_not_pinned`), modelled on the
  `ew_run_` pin in `session-scope.guard.ts`.
- **P2.3** `@RequireScopes(...)` decorator + guard (integration principals only).
- **P2.4** `X-Act-As-User` validation (active, same tenant, on the org roster) → request context.

## Phase 3 — Guards and limits

- **P3.1** `IntegrationForbiddenGuard` on api-keys, account, security, billing and Ever ID admin controllers; also blocks
  `ew_live_` keys on api-key management.
- **P3.2** Integration throttle tier (`INTEGRATION_THROTTLE_*`).

## Phase 4 — Lifecycle

- **P4.1** Create (tenant owner only; cap 20; scopes ⊆ vocabulary; pins ⊆ tenant orgs) with the "Ever Gauzy" preset.
- **P4.2** `POST /api/auth/api-keys/:id/rotate` (session only) with a grace window.
- **P4.3** Revoke → disable webhook subscriptions owned by the key (EW-P1-5 hook).
- **P4.4** Activity-log audit rows (`actorKind='external'`).

## Phase 5 — Tests

- Principal, pin, scope, act-as and forbidden-route matrices; rotation grace; throttle tier; migration spec.

## Dependencies

- **Used by**: [`integrations-api-v1`](../integrations-api-v1/plan.md), [`domain-events`](../domain-events/plan.md)
  (integration actor and `integrationKeyId` on events).
- **UI**: [`integrations-ever-gauzy`](../integrations-ever-gauzy/plan.md) (key dialog, preset, list, rotate).
