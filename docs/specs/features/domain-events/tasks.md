# Task Breakdown: Domain Events

**Feature ID**: `domain-events`
**Last updated**: 2026-10-15

## B1 — Infrastructure

- [x] **T1** Catalog types in `packages/contracts/src/events/domain/` + barrel export.
- [x] **T2** Contract test: TS catalog ↔ `event-catalog.v1.json`, examples, data schemas, signature vectors.
- [x] **T3** Entities `DomainEvent`, `DomainEventRelayState`, `PluginEventCursor` + inventories.
- [x] **T4** Migration (Postgres, MySQL, better-sqlite3): three tables + `version` on tasks, teams, agents, works,
      organizations; spec with idempotency and `down`.
- [x] **T5** `DomainEventRecorder` + `bumpAggregateVersion` + `pg_notify`.
- [x] **T6** Relay lease (compare-and-set).
- [x] **T7** Relay loop: polling, Postgres `LISTEN`, position assignment with lease fencing.
- [x] **T8** EventEmitter2 `domain.<type>` delivery + consumer registry.
- [x] **T9** `IDomainEventSubscriberPlugin` capability + manifest type + guard.
- [x] **T10** Plugin delivery with cursors, timeout, dead-letter.
- [x] **T11** Retention job + floor (+ tests: purge window, floor, 410 below the floor).

## B2 — Recording points

- [ ] **T12** DTO snapshot builders.
- [ ] **T13** Task recording points (incl. edges, chat) + `version`/`updatedAt` bumps.
- [ ] **T14** `task.runtime_updated` for PR/CI/run writers.
- [ ] **T15** Team recording points (incl. members, resources).
- [ ] **T16** Organization and roster recording points.
- [ ] **T17** Agent recording points.
- [ ] **T18** Work recording points (incl. members).
- [ ] **T19** Event-coverage contract test.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
