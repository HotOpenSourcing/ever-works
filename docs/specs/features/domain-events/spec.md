# Feature Specification: Domain Events

**Feature ID**: `domain-events`
**Status**: `Draft` — implementation in progress (EW-P1-1)
**Created**: 2026-10-15
**Last updated**: 2026-10-15
**Owner**: Product (Ruslan); implementation: the Ever Works integration lane
**Plan items**: EW-P1-1 (outbox, relay, plugin capability, P1 recording points); later phases add goal, mission, idea,
inbox, KB and email recording points.
**Related**: [`event-subscriptions`](../event-subscriptions/spec.md) (EW-664 notification registry),
[`integrations-api-v1`](../integrations-api-v1/spec.md) (feed and webhooks v2), [`activity-log`](../activity-log/),
`docs/specs/architecture/events.md` (today's EventEmitter2 events).

> **Problem.** Ever Works emits no domain events for tasks, goals, missions, teams, inbox or docs. EventEmitter2 carries
> only `work.*`, `deployment.*`, `user.*`, `fleet.*`, `app.build.*` and `budget.*`; outgoing webhooks cover 5 work and
> deploy events; and task changes leave only `activity_log` rows and in-app notifications. Nothing durable reaches
> out-of-process consumers, so an integration cannot follow changes without polling every list, and an event emitted
> just before a crash is lost.
>
> **Decision (D7).** Build durable domain events: a typed catalog, a transactional outbox and a relay. **Do not adopt
> `@nestjs/cqrs`**: its `EventBus` is as in-process and non-durable as EventEmitter2, and adopting it means a large
> command/handler refactor without solving durability. CQRS command handlers can still be adopted later per module.
>
> **Hard rule (additive only).** Existing EventEmitter2 events, notifications and activity-log writes keep working
> unchanged. Re-pointing them to domain events happens only after parity is proven.

---

## 1. Catalog

- Types and payloads are versioned in `packages/contracts/src/events/domain/`: `DOMAIN_EVENT_TYPES` (every type of the
  catalog v1), the `DomainEventEnvelope` type, per-type `data` types, and helpers (`isDomainEventType`,
  `matchesDomainEventPattern('task.*')`).
- The published JSON Schemas live in
  [`integrations-api-v1/contract/`](../integrations-api-v1/contract/README.md): the envelope, the catalog
  (`event-catalog.v1.json`) and one `data` schema per event. A contract test asserts the TypeScript catalog and the
  JSON catalog list the same types, and that recorded events validate.
- Names: `<aggregate>.<verb>` or `<aggregate>.<child>.<verb>`, lower-case, `_` inside a word (`task.runtime_updated`).

## 2. Outbox table `domain_events`

| Column                               | Type                     | Notes                                                                   |
| ------------------------------------ | ------------------------ | ----------------------------------------------------------------------- |
| `seq`                                | bigint auto-increment PK | Global order; the feed cursor is its decimal string                     |
| `id`                                 | varchar(32) unique       | `evt_<ULID>`                                                            |
| `type`                               | varchar(64)              | e.g. `task.updated`                                                     |
| `version`                            | smallint                 | payload schema version (1)                                              |
| `tenantId`, `organizationId`         | uuid                     | `organizationId` null for personal scope — never served to integrations |
| `aggregateType`, `aggregateId`       | varchar(32) / uuid       |                                                                         |
| `aggregateVersion`                   | int                      | the aggregate's `version` after the change (§4)                         |
| `actorType`, `actorId`, `actorLabel` | varchar                  | `user` \| `agent` \| `integration` \| `system`                          |
| `originTag`                          | varchar(100) null        | from `X-Sync-Origin`, e.g. `gauzy:<connectionId>`                       |
| `integrationKeyId`                   | uuid null                |                                                                         |
| `changedFields`                      | json `string[]`          |                                                                         |
| `data`                               | json                     | full post-change snapshot in the integration DTO shape                  |
| `previous`                           | json                     | previous values of `changedFields` only                                 |
| `occurredAt`                         | timestamp                |                                                                         |
| `dispatchedAt`                       | timestamp null           | set by the relay                                                        |
| `correlationId`                      | varchar(100) null        |                                                                         |

Indexes: `(tenantId, seq)`, `(organizationId, seq)`, `(aggregateType, aggregateId, seq)`, `(dispatchedAt)`.
Retention: 30 days (`DOMAIN_EVENTS_RETENTION_DAYS`); a nightly job deletes dispatched rows older than that and records
the retention floor, below which the feed answers `410 cursor_expired`.

Relay state `domain_event_relay_state` (one row per relay): the DB lease (`holder`, `leaseExpiresAt`), the dispatch
**watermark** (`watermarkSeq`) and the retention floor (`retentionFloorSeq`).

## 3. Recording

- `DomainEventRecorder.record(manager, event)` is called from **service-layer mutation methods inside their
  transaction**, with the `EntityManager` of that transaction. Mutations that were not transactional are wrapped in a
  transaction at the recording point. The event row commits or rolls back with the state change.
- **Not ORM subscribers**: Ever Works writes through QueryBuilder and bulk deletes, which subscribers miss.
- **Hard deletes** record a tombstone: `type = '<x>.deleted'`, `data` = the last snapshot + `deleted: true`.
- **Child changes** (edges, chat, members, resources) record a child event (`task.assignee.added`, …) whose `aggregate`
  is the parent with its new version.
- **Attribution**: the actor comes from the request (user, agent run, integration key with optional act-as) or is a
  named system actor (`pr-status-cron`, `recurrence-dispatcher`, …). `originTag` comes from `X-Sync-Origin`.
- **Coverage gate**: a contract test enumerates every mutating controller route in scope and asserts that each records
  its expected event. A new mutating route without an event fails CI until it records one or is listed as exempt with a
  reason.

## 4. Aggregate `version` and `updatedAt`

- `version int NOT NULL DEFAULT 1` on the P1 aggregates `tasks`, `teams`, `agents`, `works` and `organizations`
  (later phases add `goals`, `missions`, `work_proposals`, `inbox_items`, `work_knowledge_documents`).
- Incremented on **every** change to the aggregate, **including edge/child changes**: assignees, watchers, approvers,
  reviewers, blocks, relations, attachments and chat on a task; members and resources on a team; members on a work;
  roster rows on an organization.
- `updatedAt` is bumped in the same cases, so `updatedSince` also catches edge changes.
- **Machine-only writes are excluded**: the PR-status cron, CI state and `latestRun*` columns bump neither `version` nor
  `updatedAt`. They record `task.runtime_updated` (opt-in for integrations), so they never cause false sync conflicts.

## 5. Relay

`DomainEventRelay` (API process):

- **One leader** across replicas via a compare-and-set DB lease on `domain_event_relay_state` (works on Postgres, MySQL
  and better-sqlite3). Non-leaders retry the lease on every tick.
- **Wake-up**: polls every 1 s; on Postgres it also `LISTEN`s on `domain_events`, and the recorder issues
  `pg_notify('domain_events', '')` inside the writing transaction, so a commit wakes the relay at once.
- **Order and gaps**: it dispatches rows with `seq > watermark` in `seq` order. A missing `seq` (a concurrent transaction
  that has not committed yet, or one that rolled back) holds the watermark for up to `DOMAIN_EVENTS_GAP_TIMEOUT_MS`
  (default 10 s) before it is skipped, so the feed never serves a `seq` beyond a still-committing lower one.
- For each event: `eventEmitter.emitAsync('domain.<type>', envelope)` (listener errors are logged, never block the
  relay), hand-off to registered consumers (webhooks v2 in EW-P1-5), then `dispatchedAt` and the watermark advance.
- The feed (`GET /api/integrations/v1/events`) serves only `seq ≤ watermark`; `head` is the watermark.
- Off switch: `DOMAIN_EVENTS_RELAY_ENABLED=false` stops the relay (recording continues; events wait in the outbox).

## 6. Plugin capability `IDomainEventSubscriberPlugin`

```ts
interface IDomainEventSubscriberPlugin {
	readonly subscribes: readonly string[]; // e.g. ['task.*', 'goal.completed']
	onDomainEvent(event: DomainEventEnvelope, ctx: PluginEventContext): Promise<void>;
}
```

- Declared in `packages/plugin/src/contracts/capabilities/domain-event-subscriber.interface.ts` and registered as the
  `domain-event-subscriber` capability in the plugin manifest types.
- **At-least-once** through `plugin_event_cursors(pluginId, tenantId, lastSeq, …)`: a plugin that was down catches up
  from its cursor. Only events of tenants where the plugin is enabled are delivered.
- Runs in the relay's process with a per-plugin timeout (`DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS`, default 10 s). After 10
  consecutive failures on one event, that event is dead-lettered (logged and counted on the cursor) and the cursor
  moves on.

## 7. In-process listeners

`@OnEvent('domain.task.updated')` and friends receive the envelope. The EW-664 notification fan-out and the activity
log keep their direct calls (no-removal rule) until a listener reaches parity; then the direct call is retired in a
separate, owner-visible change.

**Alignment with [`event-subscriptions`](../event-subscriptions/spec.md) (EW-664).** The two catalogs answer different
questions and both stay:

|                 | Domain event catalog (this spec)              | Notification event registry (EW-664, `notification_event_types`) |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Question        | _What changed?_ (one row per state change)    | _What may we tell a person, and on which channels?_              |
| Keys            | `task.transitioned`, `task.assignee.added`, … | `task_status_changed`, `task_assigned`, `inbox_question`, …      |
| Audience        | integrations, plugins, in-process listeners   | users, through their channel matrix, quiet hours and mutes       |
| Source of truth | `packages/contracts/src/events/domain/`       | `packages/agent/src/notifications/core-event-catalogue.ts`       |

Domain events **feed** the registry: a notification listener subscribes to `domain.<type>`, maps the type to its
registry key (for example `task.assignee.added` → `task_assigned`, `task.transitioned` → `task_status_changed`) and calls
the existing `resolveAndDispatch` path, so the per-user matrix, quiet hours and category mutes keep deciding delivery.
The registry's coverage test (`event-registry-coverage.spec.ts`) still applies to every key such a listener emits. Plugin
domain-event types use the same `plugin:<pluginId>:` prefix rule as plugin notification keys.

## 8. Out of scope

- `@nestjs/cqrs`.
- Exactly-once delivery: consumers dedupe on `id` (and on `aggregate.version` per aggregate).
- Cross-tenant ordering guarantees beyond the global `seq`.

## 9. Acceptance criteria

- [ ] A state change and its event commit together; a rolled-back change leaves no event.
- [ ] With two API replicas only one relays; killing it hands over within one lease period.
- [ ] Postgres: an event is relayed within ~100 ms of commit (LISTEN); MySQL/SQLite within ~1 s (polling).
- [ ] A slow transaction holding a lower `seq` never lets the feed skip it.
- [ ] Every mutating route in scope records its event (coverage test).
- [ ] Runtime-only task writes record `task.runtime_updated` and change neither `version` nor `updatedAt`.
- [ ] A plugin that was stopped receives the events it missed, in `seq` order, once it is back.
- [ ] Rows older than the retention window are purged; a feed cursor below the floor answers 410.

## 10. Constitution gates

- [x] **I** Plugin-first — a new plugin capability consumes the events.
- [x] **II** Capability-driven — the relay depends only on the `IDomainEventSubscriberPlugin` contract.
- [x] **III–V** Schema changes ship with migrations on Postgres, MySQL and better-sqlite3, with a working `down`.
- [x] **VI** Tests — recorder, relay (lease, gaps, LISTEN), retention, plugin cursors, coverage and contract tests.
- [x] **VII** Secret hygiene — event `data` uses the integration DTOs, which carry no secrets.
- [x] **X** Backwards-compat — additive; existing events, notifications and activity rows are unchanged.
