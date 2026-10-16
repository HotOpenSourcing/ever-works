# Feature Specification: Integration API v1

**Feature ID**: `integrations-api-v1`
**Status**: `Draft` — contract published (`v1-draft.1`), implementation not started
**Created**: 2026-10-15
**Last updated**: 2026-10-15
**Owner**: Product (Ruslan); contract owner: the Ever Works integration lane
**Plan items**: EW-P1-4, EW-P1-5, EW-P1-6 (P1); EW-P2-1/2/5, EW-P3-1/2, EW-P4-1/2 (later resources)
**Source of truth**: integration plan doc 03 Part B (private `ever-co/homelab`,
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/03-events-sync-engine-and-contract.md`). This file
mirrors it for readers of this repo, and [`contract/`](./contract/README.md) holds the machine-readable schemas.

> **Why a separate, versioned namespace.** User-facing routes (`/api/me/goals`, `/api/tasks`) change often and filter by
> owner. The integration namespace gives Ever Gauzy (and later other systems) a **stable** contract: it calls the same
> domain services, accepts only the integration principal (an `ew_int_` key now, Ever ID tokens later — see
> [`integration-keys`](../integration-keys/spec.md)), and a breaking change requires `/v2`.
>
> **Hard rule (additive only):** nothing here changes an existing route. The per-user behaviour of the app stays the
> default (owner decision, 2026-10-15).

**Base URL:** `https://api.ever.works/api/integrations/v1` (stage and dev use their own API hosts). Paths below are
relative to it. The plan's shorthand `GET /integrations/whoami` and `GET /integrations/events` (doc 02) mean these same
`/api/integrations/v1/...` routes.

---

## 1. Common rules (B.1)

### 1.1 Request headers

| Header                                            | Requirement                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer ew_int_…` (or `x-api-key`) | required                                                                                                                            |
| `X-Scope-Slug: <ewOrgSlug>`                       | required on org resources; must name a pinned org (`403 org_not_pinned`)                                                            |
| `X-Act-As-User: <ewUserId>`                       | optional, writes only; the user must be active, in the key's tenant and on the target org's roster (`403 act_as_forbidden`)         |
| `X-Sync-Origin: gauzy:<connectionId>`             | sent on every write; persisted as `domain_events.originTag` and echoed as `origin.tag`                                              |
| `Idempotency-Key: <≤128 chars>`                   | required on every POST that creates something; the response is stored for 24 h per `(keyId, key)` and replayed                      |
| `If-Match: "<version>"`                           | optional on PATCH/PUT/DELETE of a versioned aggregate; a mismatch answers `412 version_mismatch` with `details {expected, current}` |

### 1.2 Responses

- Every versioned resource carries `version` and an `ETag: "<version>"` header. Child rows (members, team
  members/resources, work members, task edges, comments) have no version of their own: a change to one bumps the
  parent's version. Comment routes take no `If-Match` in v1.
- **Lists**: `?updatedSince=<ISO>&cursor=<opaque>&limit=<≤500, default 200>&includeArchived=false`, ordered by
  `(updatedAt, id)`, answering `{ "data": [...], "nextCursor": "…" | null, "hasMore": bool }`
  ([`Page`](./contract/schemas/common.schema.json)).
- **Errors**: `{ "error": { "code": "…", "message": "…", "details": {} } }` ([schema](./contract/schemas/error.schema.json)):

| Status | Codes                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 400    | `validation_failed` (details: `fields[{path, message}]`)                                                           |
| 401    | `invalid_key`                                                                                                      |
| 403    | `scope_missing`, `org_not_pinned`, `act_as_forbidden`                                                              |
| 404    | `not_found`                                                                                                        |
| 409    | `transition_blocked` (details: `blockers[]`, `pendingApprovers[]`, `path[]`), `duplicate_external_ref`, `conflict` |
| 410    | `cursor_expired`                                                                                                   |
| 412    | `version_mismatch`                                                                                                 |
| 422    | `domain_rule`                                                                                                      |
| 429    | `rate_limited` (with `Retry-After`)                                                                                |
| 5xx    | `internal_error` (retry with back-off)                                                                             |

### 1.3 Visibility

The integration principal sees every row in its pinned orgs whose `visibility` is `team` or `organization`
([`record-visibility`](../record-visibility/spec.md)), regardless of owner. Writes may set `team` or `organization`
only; `private` answers `422 domain_rule`. Scope rule (owner decision D11): a record attached to a Team is team-scoped,
a record with no team is organization-scoped. `private` records never leave Ever Works.

## 2. Identity and change feed (B.2)

| Method | Path      | Scope         | Notes                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/whoami` | any           | `{keyId, keyName, tenant{id,slug}, organizations[{id,slug,displayName}], scopes[], apiVersion:"1", feedHead:"<seq>", limits{readsPerMin,writesPerMin}}` ([schema](./contract/schemas/resources/whoami.schema.json))                                                                                                                                                                   |
| GET    | `/events` | `events:read` | `?after=<seq>&limit=≤1000&types=task.*,goal.*&excludeOrigin=gauzy:<id>` → `{events:[Envelope], nextCursor, hasMore, head}` ([schema](./contract/schemas/resources/events-page.schema.json)). Only pinned orgs, and never events of `private` aggregates except the id-only `*.visibility_changed` notice (below). A cursor older than retention → `410 cursor_expired` (full resync). |

- Events come in ascending `seq`. `nextCursor` is the `seq` to pass as `after` next time; `head` is the newest feed
  position overall. Positions are global across organizations, so `head` (and `whoami.feedHead`) is never below the
  retention floor: a consumer that is caught up, or a quiet organization, can always continue from `head` without a
  `410`. `seq` is a gap-free feed position assigned when Ever Works dispatches the event, so a consumer
  paging with `after` never misses a committed event (see [`domain-events`](../domain-events/spec.md) §2).
- **Private records**: events of an aggregate that is `private` at event time are never served. The one exception is
  `<aggregate>.visibility_changed` **to** `private`: it is always served (for pinned orgs) with `data` reduced to
  `{id, visibility:'private'}`, so consumers learn to stop syncing without seeing the content.
- `types` takes exact types and `<domain>.*` wildcards. `task.runtime_updated` is returned only when named exactly.
- Retention is 30 days (`DOMAIN_EVENTS_RETENTION_DAYS`), see [`domain-events`](../domain-events/spec.md).

## 3. Event envelope (B.3)

The feed, webhooks v2 and EW plugins share one envelope ([schema](./contract/schemas/event-envelope.schema.json),
[examples](./contract/examples/events/)):

```json
{
	"id": "evt_01JAB…",
	"seq": "102938",
	"type": "task.updated",
	"version": 1,
	"occurredAt": "2026-10-15T18:00:00.000Z",
	"tenantId": "…",
	"organizationId": "…",
	"aggregate": { "type": "task", "id": "…", "version": 17 },
	"actor": { "type": "user|agent|integration|system", "id": "…", "label": "Ruslan" },
	"origin": { "tag": "gauzy:8f…", "integrationKeyId": "…" },
	"changedFields": ["status", "assignees"],
	"data": { "…full integration DTO (§6)…": "" },
	"previous": { "status": "todo" }
}
```

- `aggregate.version` is the aggregate's version **after** the change.
- **Applying events (consumer rules).** Webhooks may arrive out of order and more than once; the feed is in `seq`
  order. Dedupe every event on `id`. Then:
    - **Full-snapshot events** (`<x>.created`, `<x>.updated`, `<x>.transitioned`, `<x>.status_changed`,
      `<x>.archived`, `<x>.deleted`, `<x>.visibility_changed`): skip the event when `aggregate.version` ≤ the version
      already applied for that aggregate; otherwise apply `data` and store `aggregate.version`.
    - **Child events** (`catalog.child` set, e.g. `task.comment.created`, `team.member.added`): `data` is only the child,
      so never skip one by the parent's version — an older child event can still carry a change the newer one does not.
      Apply them idempotently by child identity (comments by `data.id` + `updatedAt`, set edges by their keys: adding an
      existing member or removing an absent one is a no-op). When in doubt, fetch the parent's full DTO, which carries
      every set.
    - **`task.runtime_updated`** carries the unchanged current version: apply it when its `seq` (feed) or `occurredAt`
      (webhooks) is newer than the last runtime update applied for that task; it never conflicts with user edits.
- **Delete events**: `data` is the last known snapshot plus `"deleted": true`; `aggregate.version` is the last version + 1.
- **Child events** (for example `task.comment.created`, `team.member.added`): `data` is the child DTO and `aggregate` is
  the parent with its new version.
- `previous` holds the previous values of `changedFields` only (`{}` when empty). An optional `correlationId` may be
  present.

## 4. Event catalog v1 (B.4)

Machine-readable: [`contract/event-catalog.v1.json`](./contract/event-catalog.v1.json) (type, aggregate, `data` schema,
phase, child / opt-in flags).

| Domain        | Events                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization  | `organization.updated`, `organization.member.added`, `organization.member.updated`, `organization.member.removed`                                                                                                                                                                                               |
| Agents        | `agent.created`, `agent.updated`, `agent.status_changed`, `agent.archived`, `agent.deleted`                                                                                                                                                                                                                     |
| Teams         | `team.created`, `team.updated`, `team.deleted`, `team.member.added`, `team.member.updated`, `team.member.removed`, `team.resource.added`, `team.resource.removed`                                                                                                                                               |
| Works         | `work.created`, `work.updated`, `work.archived`, `work.deleted`, `work.member.added`, `work.member.updated`, `work.member.removed`                                                                                                                                                                              |
| Missions (P2) | `mission.created`, `mission.updated`, `mission.status_changed`, `mission.deleted`, `mission.goal.linked`, `mission.goal.unlinked`, `mission.work.linked`, `mission.work.unlinked`                                                                                                                               |
| Goals (P2)    | `goal.created`, `goal.updated`, `goal.status_changed`, `goal.progress_changed` (at most 1 per goal per 5 min), `goal.archived`, `goal.unarchived`, `goal.deleted`                                                                                                                                               |
| Ideas (P2)    | `idea.created`, `idea.updated`, `idea.status_changed`, `idea.deleted`                                                                                                                                                                                                                                           |
| Tasks         | `task.created`, `task.updated`, `task.transitioned`, `task.deleted`; `task.assignee.added/removed`, `task.watcher.added/removed`, `task.block.added/removed`, `task.relation.added/removed`; `task.comment.created/updated/deleted`; `task.attachment.added/removed` (P3); `task.runtime_updated` (opt-in only) |
| Inbox (P3)    | `inbox.item.created`, `inbox.item.answered`, `inbox.item.state_changed`, `inbox.item.deleted` (`data.recipientUserId` always set)                                                                                                                                                                               |
| KB (P3)       | `kb.document.created/updated/moved/archived/unarchived/deleted/review_changed`; `kb.folder.created/updated/deleted`                                                                                                                                                                                             |
| Email (P4)    | `email.message.received`, `email.message.sent`, `email.message.status_changed`                                                                                                                                                                                                                                  |
| Visibility    | `task.visibility_changed`, `goal.visibility_changed`, `mission.visibility_changed`, `idea.visibility_changed`, `agent.visibility_changed`. A change **to** `private` carries only `{id, visibility:'private'}` in `data`.                                                                                       |

Changes with no dedicated child event record the parent's full-snapshot event: a task's **approvers** and **reviewers**
(added, removed, or a decision such as `approvalState`) record `task.updated` with `changedFields` `["approvers"]` or
`["reviewers"]`; labels, teams and every other field change likewise record `task.updated`.

`task.runtime_updated` is emitted for machine-only task writes (PR, CI and run state). It bumps neither `version` nor
`updatedAt`, carries the unchanged current version, and is excluded from the feed and webhooks unless requested by its
exact name.

## 5. Webhooks v2 (B.5)

| Method | Path                          | Notes                                                                                                             |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/webhooks`                   | `{url, events[], organizationIds[], excludeOriginTags[], description}` → `{id, secret, …}` (secret returned once) |
| GET    | `/webhooks`                   |                                                                                                                   |
| PATCH  | `/webhooks/:id`               | Pause **and resume** both work in v2 (`status: active \| paused`)                                                 |
| POST   | `/webhooks/:id/rotate-secret` | Returns the new secret once; the previous one keeps signing as a second `v1` during the grace window              |
| POST   | `/webhooks/:id/test`          |                                                                                                                   |
| DELETE | `/webhooks/:id`               |                                                                                                                   |

- A subscription is owned by the integration key and is disabled when the key is revoked
  ([schema](./contract/schemas/resources/webhook-subscription.schema.json)).
- **Delivery**: one event per POST, body = the envelope (§3), with headers `X-Ever-Works-Event` (type),
  `X-Ever-Works-Event-Id`, `X-Ever-Works-Delivery` (uuid) and
  `X-Ever-Works-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>` — the same scheme as Gauzy's
  `verifyWebhookSignature`. The HMAC key is the secret string exactly as returned (UTF-8 bytes); tolerance is 300 s,
  inclusive. **Test vectors:** [`contract/webhook-signature-vectors.json`](./contract/webhook-signature-vectors.json).
- **Retry** follows the existing ladder (30 s → 24 h); only 5xx and timeouts are retried.
- **Ordering is not guaranteed.** Consumers order by `seq` per aggregate and fill gaps from `/events`.
- Legacy v1 subscriptions (user-owned, 5 work/deploy events, `X-Ever-Works-Signature-256`) continue unchanged.

## 6. Resources (B.6)

**Fields on every versioned DTO** ([`ResourceBase`](./contract/schemas/common.schema.json)): `id`, `organizationId`,
`version`, `createdAt`, `updatedAt`, `visibility` (`team` | `organization`), `visibilityExplicit`, `owner {type, id}`,
`createdBy {type, id, label}`, `externalLinks [{source, installationId, externalId, externalUrl}]` (filtered to the
caller's source). `teamIds[]` on tasks, goals, missions, ideas, works and agents: `teamId` plus the `team_resources`
rows (for agents: team memberships), as one set; writable on POST/PATCH where the resource is writable, the first id
stored as `teamId` where the entity has that column. Teams are org-wide (`visibility` always `organization`); a Work's
visibility is derived (`team` when it sits on a team).

| Resource      | Routes                                                                                                                                                                                                                                                                                                                 | Scope          | Schema                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Organization  | `GET /organization` (the `X-Scope-Slug` org)                                                                                                                                                                                                                                                                           | `org:read`     | [organization](./contract/schemas/resources/organization.schema.json)                                                   |
| Members       | `GET /members` — `userId, username, displayName?, email, emailVerified, avatarUrl, role, joinedAt, everIdSubjects[]`                                                                                                                                                                                                   | `members:read` | [member](./contract/schemas/resources/member.schema.json)                                                               |
| Agents        | `GET /agents`, `GET /agents/:id` — `id, name, slug, title, capabilities, status, scope, scopeTargetId, reportsToAgentId, avatar{mode,url}, modelId, lastRunAt, webUrl`                                                                                                                                                 | `agents:read`  | [agent](./contract/schemas/resources/agent.schema.json)                                                                 |
| Teams         | `GET`/`POST /teams`, `GET`/`PATCH`/`DELETE /teams/:id`, `PUT /teams/:id/members` (full set), `PUT /teams/:id/resources`                                                                                                                                                                                                | `teams:*`      | [team](./contract/schemas/resources/team.schema.json)                                                                   |
| Works         | `GET /works`, `GET /works/:id` (members, `repoUrls[]`, `website`, `kind`, `status`, `webUrl`). P2: `POST /works` with `kind:'project'`                                                                                                                                                                                 | `works:*`      | [work](./contract/schemas/resources/work.schema.json)                                                                   |
| Tasks         | `GET`/`POST /tasks`, `GET`/`PATCH`/`DELETE /tasks/:id`; `POST /tasks/:id/transition {to, mode:'sync'}` (shortest legal path; gates → `409 transition_blocked`); `PUT /tasks/:id/assignees`, `/watchers`, `/blocks`, `/relations`; comments `GET`/`POST /tasks/:id/comments`, `PATCH`/`DELETE /tasks/:id/comments/:cid` | `tasks:*`      | [task](./contract/schemas/resources/task.schema.json), [comment](./contract/schemas/resources/task-comment.schema.json) |
| Links         | `GET /links?entityType=&externalId=`, `PUT /links/:entityType/:entityId {externalId, externalUrl}`, `DELETE /links/:entityType/:entityId`                                                                                                                                                                              | `links:write`  | [link](./contract/schemas/resources/link.schema.json)                                                                   |
| Batch         | `POST /batch {operations:[{method, path, headers?, body?}]}` — ≤100 operations, in order, not atomic; per-operation `{status, body}`; each counts against limits                                                                                                                                                       | per operation  | [requests](./contract/schemas/requests.schema.json) `Batch`                                                             |
| Missions (P2) | `GET`/`POST /missions` (POST forces `status='paused'`), `GET`/`PATCH`/`DELETE /missions/:id` (PATCH cannot set `active`), `PUT /missions/:id/goals`, `PUT /missions/:id/works`                                                                                                                                         | `missions:*`   | P2                                                                                                                      |
| Goals (P2)    | `GET`/`POST /goals` (POST forces `status='draft'`), `GET`/`PATCH`/`DELETE /goals/:id` (PATCH cannot activate or resume), `PUT /goals/:id/criteria`, `PUT /goals/:id/dod`, `POST /goals/:id/samples {criterionId?, value, sampledAt}`                                                                                   | `goals:*`      | P2                                                                                                                      |
| Ideas (P2)    | `GET`/`POST /ideas` (POST forces `source='external'`, `status='pending'`), `GET`/`PATCH /ideas/:id`, `POST /ideas/:id/dismiss`, `POST /ideas/:id/restore`                                                                                                                                                              | `ideas:*`      | [idea](./contract/schemas/resources/idea.schema.json)                                                                   |
| Inbox (P3)    | `GET /inbox/items`, `GET /inbox/items/:id`, `POST /inbox/items/:id/reply {text?, optionId?}` (act-as = the recipient; returns `{routed, restart}`), `PATCH /inbox/items/:id/state {unread?, archived?}`                                                                                                                | `inbox:*`      | P3                                                                                                                      |
| KB (P3)       | `GET`/`POST /kb/documents`, `GET`/`PATCH`/`DELETE /kb/documents/:id`, `POST /kb/documents/:id/{accept,archive,unarchive,move}`, `GET`/`POST`/`PATCH`/`DELETE /kb/folders`                                                                                                                                              | `kb:*`         | P3                                                                                                                      |
| Email (P4)    | `GET /email/messages?updatedSince=&agentId=`, `POST /email/inbound`                                                                                                                                                                                                                                                    | `email:*`      | P4                                                                                                                      |

Request bodies for the P1 writes: [`contract/schemas/requests.schema.json`](./contract/schemas/requests.schema.json).
PUT-set routes take an object (`{members:[…]}`, `{resources:[…]}`, `{assignees:[…]}`, `{userIds:[…]}`,
`{blockedBy:[…]}`, `{relations:[…]}`) and answer the parent DTO. Task status is never set by PATCH; on create it may
be `backlog` (default) or `todo`.

### 6.1 Creating with an external reference

- Every create accepts `externalRef: {source:'gauzy', externalId, externalUrl}`.
- The row and its `external_record_links` row are created **atomically** (tasks and teams: one transaction, T17a;
  comments, KB documents and folders: created, then linked, undone on a lost race).
- A repeat with the same `externalRef` returns **200 with the existing entity**, not a duplicate. Together with
  `Idempotency-Key` this makes creates safe to retry.

### 6.2 Spend safety (D9)

Integration writes never start Ever Works autonomous spend: goals are created as `draft`, missions as `paused`, ideas
are never accepted or built through this API, and PATCH can neither activate a goal or mission nor resume one.

## 7. Acceptance criteria

- [ ] Every DTO and event served under `/api/integrations/v1` validates against [`contract/`](./contract/README.md)
      (contract tests in CI).
- [ ] The webhook signer reproduces every valid vector, and the reference verifier rejects every invalid one.
- [ ] `If-Match` mismatch → 412; repeated `Idempotency-Key` → replayed response; repeated `externalRef` → 200 existing.
- [ ] `/events` pages losslessly from `whoami.feedHead`; a cursor older than retention → 410.
- [ ] A Gauzy-originated write is excluded from that connection's feed (`excludeOrigin`) and webhooks
      (`excludeOriginTags`).
- [ ] `POST /tasks/:id/transition {mode:'sync'}` reaches `done` from `backlog` through the legal path, and answers 409
      with blockers / pending approvers when a gate holds.
- [ ] OpenAPI for `/integrations/v1` is served in production at `/api/integrations/v1/openapi.json` with the
      `x-api-key` and bearer schemes.

## 8. Clarifications in `v1-draft.1`

Recorded as CR-1 on the plan's STATUS board (additive, nothing breaking): canonical `/api/integrations/v1` paths;
`organizations` gets a `version` so organization events carry one; child rows have no own version and comment routes take
no `If-Match`; team visibility fixed to `organization`, work visibility derived; delete events carry last version + 1;
`internal_error` for 5xx; optional envelope `correlationId`; feed `seq` is a relay-assigned, gap-free position;
consumer rules for applying full-snapshot, child and runtime events (§3); private aggregates' events are never served
except the id-only `*.visibility_changed` notice; approver and reviewer changes record `task.updated`; `Actor.id` is
always set; PUT-set bodies are objects and answer the parent DTO; the
webhook HMAC key is the secret's UTF-8 bytes, with multiple `v1` during rotation; task create status `backlog|todo`; link
`source` derived from the key's `integrationKind`; subscription status `disabled` after key revocation; member DTO adds
`organizationId`, `updatedAt`, `isActive`.
