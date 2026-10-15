# Task Breakdown: Domain Events

**Feature ID**: `domain-events`
**Last updated**: 2026-10-15

## B1 — Infrastructure

- [ ] **T1** Catalog types in `packages/contracts/src/events/domain/` + barrel export.
- [ ] **T2** Contract test: TS catalog ↔ `event-catalog.v1.json`, examples, data schemas, signature vectors.
- [ ] **T3** Entities `DomainEvent`, `DomainEventRelayState`, `PluginEventCursor` + inventories.
- [ ] **T4** Migration (Postgres, MySQL, better-sqlite3): three tables + `version` on tasks, teams, agents, works,
      organizations; spec with idempotency and `down`.
- [ ] **T5** `DomainEventRecorder` + `bumpAggregateVersion` + `pg_notify`.
- [ ] **T6** Relay lease (compare-and-set).
- [ ] **T7** Relay loop: polling, Postgres `LISTEN`, position assignment with lease fencing.
- [ ] **T8** EventEmitter2 `domain.<type>` delivery + consumer registry.
- [ ] **T9** `IDomainEventSubscriberPlugin` capability + manifest type + guard.
- [ ] **T10** Plugin delivery with cursors, timeout, dead-letter.
- [ ] **T11** Retention job + floor (+ tests: purge window, floor, 410 below the floor).

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
