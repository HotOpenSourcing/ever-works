# Task Breakdown: Integration Keys

**Feature ID**: `integration-keys`
**Last updated**: 2026-10-15

- [ ] **T1** `api_keys` integration columns + migration (3 dialects) + spec.
- [ ] **T2** `tasks.createdByType='integration'`; `task_chat_messages.authorType='integration'` + `externalAuthor`.
- [ ] **T3** `ew_int_` authentication → integration principal.
- [ ] **T4** Org pin enforcement (`403 org_not_pinned`).
- [ ] **T5** `@RequireScopes` guard (`403 scope_missing`).
- [ ] **T6** `X-Act-As-User` validation (`403 act_as_forbidden`).
- [ ] **T7** `IntegrationForbiddenGuard` (+ stop `ew_live_` keys minting keys).
- [ ] **T8** Integration throttle tier.
- [ ] **T9** Create with "Ever Gauzy" preset; cap 20 per tenant.
- [ ] **T10** Rotation with grace window.
- [ ] **T11** Revocation → disable webhook subscriptions.
- [ ] **T12** Activity-log audit rows.
- [ ] **T13** Test matrices (principal, pin, scope, act-as, forbidden routes, rotation, throttle).

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
