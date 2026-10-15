# Feature Specification: Integration Keys and the Integration Principal

**Feature ID**: `integration-keys`
**Status**: `Draft` (EW-P1-2)
**Created**: 2026-10-15
**Last updated**: 2026-10-15
**Owner**: Product (Ruslan)
**Related**: [`api-keys`](../api-keys/spec.md), [`integrations-api-v1`](../integrations-api-v1/spec.md),
[`record-visibility`](../record-visibility/spec.md), `docs/specs/features/app-works/APW-12-ever-id/` (Ever ID, D14)

> **Owner decision D1 (2026-10-15): connect manually.** An admin creates an Ever Works _integration key_ at
> `app.ever.works/settings/api-keys` and pastes it into Gauzy. One-click connect waits for Ever ID; when it comes, only
> how the principal is authenticated changes (an Ever ID token instead of a key). Ever Works builds no OAuth server, so
> decision D14 (Ever Works is never an identity provider) stands.
>
> **Why a new key kind.** Today `ew_live_` keys impersonate their user with no scopes and no organization pin; the caller
> picks any organization of the tenant per request, and any key can mint more keys. That is unsafe to hand to another
> system.
>
> **Hard rule (additive only):** personal `ew_live_` keys, sessions and fleet-run tokens behave exactly as today (except
> that a key can no longer mint keys, which closes an existing hole).

---

## 1. Key columns (additive, on `api_keys`)

| Column                                      | Value                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `kind`                                      | adds `'integration'` (today `personal` \| `fleet-run`)                     |
| key prefix                                  | `ew_int_` (distinct from `ew_live_` and `ew_run_`)                         |
| `scopes`                                    | JSON `string[]` (§3)                                                       |
| `organizationIds`                           | JSON `string[]`, required, at least one, every org in the creator's tenant |
| `integrationKind`                           | `'ever-gauzy'` \| `'generic'`                                              |
| `description`                               | text                                                                       |
| `rotatedFromKeyId`, `previousKeyGraceUntil` | rotation                                                                   |

## 2. Rules

- **Who can create**: the tenant owner (later also org `owner`/`admin` roles, EW-P2-6). Integration keys do not count
  against the 10 personal keys; their own cap is 20 per tenant.
- **Session-only actions**: an integration key can never call key management, account, security, billing or Ever ID
  admin routes (`IntegrationForbiddenGuard`). The same guard stops `ew_live_` keys from minting keys.
- **Principal**: an `ew_int_` key does **not** act as its creator. It becomes
  `AuthenticatedUser{ authMethod:'integration', integrationKeyId, tenantId, allowedOrganizationIds, scopes, ownerUserId }`.
- **Org pin**: every org request needs `X-Scope-Slug` (or `X-Organization-Id`) naming a pinned org, else
  `403 org_not_pinned`.
- **Scope check**: route-level `@RequireScopes('tasks:write')`. Personal keys and sessions are not scope-checked; only
  integration principals are.
- **Reads**: org-wide across owners within the pins: every row with `organizationId` in the pins and
  `visibility <> 'private'` ([`record-visibility`](../record-visibility/spec.md)). Inbox reads return all recipients in
  the pinned orgs with `recipientUserId`.
- **Writes**: optional `X-Act-As-User: <ewUserId>` — active, in the tenant, on the target org's roster
  (`403 act_as_forbidden` otherwise). The row's owner/creator/author is that user and `activity_log.actorKind='external'`
  records the integration as the means. Without act-as, the owner is the key's `ownerUserId`,
  `createdByType='integration'`, `createdById=<keyId>`, with optional `externalAuthor{name, avatarUrl, source}`.
- **Attribution columns**: `tasks.createdByType` gains `'integration'`; `task_chat_messages.authorType` gains
  `'integration'` plus an `externalAuthor` JSON column.

## 3. Scope vocabulary v1

| Scope                              | Grants                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `org:read` / `org:write`           | org profile, roster read / create an org (P2)                                  |
| `members:read` / `members:write`   | org members; invitations (P2)                                                  |
| `agents:read`                      | agents in pinned orgs (Ever Works owns agents)                                 |
| `teams:read` / `teams:write`       | teams, team members, team resources                                            |
| `works:read` / `works:write`       | works and work members; create a repo-less `project` Work (P2)                 |
| `missions:read` / `missions:write` | missions and their goal/work links (writes never activate)                     |
| `goals:read` / `goals:write`       | goals, criteria, DoD, samples (writes never activate)                          |
| `ideas:read` / `ideas:write`       | work proposals (writes never accept or build)                                  |
| `tasks:read` / `tasks:write`       | tasks, edges, chat, transitions                                                |
| `inbox:read` / `inbox:write`       | inbox items for all recipients; reply, read and archive (act-as the recipient) |
| `kb:read` / `kb:write`             | org and work KB documents and org library folders                              |
| `email:read` / `email:write`       | agent email messages; external inbound push (P4)                               |
| `events:read`                      | change feed `GET /api/integrations/v1/events`                                  |
| `webhooks:manage`                  | the key's own webhook subscriptions                                            |
| `links:write`                      | external record links                                                          |

The **"Ever Gauzy" preset** includes everything except `org:write` and `email:write` (opt-in at creation). Never
grantable: `goals:activate`, `missions:activate`, `ideas:build` (spend safety, D9).

## 4. Limits and rotation

- **Throttle tier** for integration principals: default 600 writes/min and 3000 reads/min per key
  (`INTEGRATION_THROTTLE_*`), replacing the 30/min per-route write caps for this principal only.
- **Rotation**: `POST /api/auth/api-keys/:id/rotate` (session only) returns a new secret; the old one works until
  `previousKeyGraceUntil` (24 h default).
- **Revocation** disables the key at once and disables its webhook subscriptions.

## 5. Audit

Every integration write produces an `activity_log` row with `actorKind='external'`,
`actorLabel='Ever Gauzy (<keyName>)'` and the act-as user.

## 6. Later: Ever ID (P5)

`EverIdDelegationService` / `@DelegatedRead` grow into scope-checked server-to-server writes that map onto the same
integration principal, enabling one-click connect from Gauzy. Ever Works stays a relying party (D14).

## 7. Acceptance criteria

- [ ] An `ew_int_` key reads org-wide rows in its pinned orgs and gets `403 org_not_pinned` elsewhere.
- [ ] A route without the needed scope answers `403 scope_missing`; sessions and `ew_live_` keys are unaffected.
- [ ] Neither an `ew_int_` nor an `ew_live_` key can create, list or delete keys, or reach account/billing/security/Ever
      ID admin routes.
- [ ] Act-as with an off-roster user answers `403 act_as_forbidden`; a valid act-as write is attributed to that user.
- [ ] Rotation keeps the old secret valid until the grace time, then refuses it.
- [ ] Integration writes are throttled by the integration tier, not the 30/min per-route caps.
