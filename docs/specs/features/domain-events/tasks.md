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

- [x] **T12** DTO snapshot builders (`domain-event-snapshots.ts`) + `DomainEventPublisher` (`created`, `changed`, `child`,
      `beforeDelete`/`deleted`, `runtime`, `recordAfterWrite`).
- [x] **T13** Task recording points (incl. edges, chat, templates) + `version`/`updatedAt` bumps (`task-recording.spec.ts`).
- [x] **T14** `task.runtime_updated` for PR/CI/run writers (run denorm, PR status, discard branch).
- [x] **T15** Team recording points (incl. members, resources) (`team-recording.spec.ts`).
- [x] **T16** Organization and roster recording points (invitation accept/remove, organization fields).
- [x] **T17** Agent recording points (`agent-recording.spec.ts`; import is a follow-up, spec §3).
- [x] **T18** Work recording points (incl. members) (`work-recording.spec.ts`; claim-accept member is a follow-up).
- [x] **T19** Event-coverage contract test (`apps/api/src/domain-events/domain-event-route-coverage.spec.ts`).

## P2 — Recording points

- [x] **T20** Ideas (EW-P2-1): `version` + `createdBy` columns (migration `1795100000000`), `idea.*` recorded by
      `WorkProposalRepository`, `WorkProposalService.createExternal` / `updateContent` / `restore`, idea DTO schema
      (`idea-recording.spec.ts`; the coverage gate now scans `work-proposals.controller.ts`).
- [ ] **T21** Goals (EW-P2-2).
- [ ] **T22** Missions (EW-P2-5), incl. the Ideas a Mission clone copies.

## P3 — Inbox (EW-P3-1)

- [x] **T23** `inbox_items.version` + `inbox_item` snapshot (`resources/inbox-item.schema.json`, catalog `dataSchema`) + `InboxService` recording points (`inbox-recording.spec.ts`; a reply whose routing fails records the read flip its claim made).
- [x] **T24** Integration routes `GET /inbox/items[/:id]`, `POST /inbox/items/:id/reply`, `PATCH /inbox/items/:id/state`
      (act-as = the recipient only; `integrations-api-v1` spec §9) + coverage gate entries (the Inbox, escalation and
      approvals controllers, whose decisions close the Inbox mirror).
      `inbox.item.*` events are recorded `visibility: recipient` (an inbox item is one person's message): the feed and
      webhooks v2 serve them only to an integration key holding `inbox:read` (never to a user-owned subscription or a
      key without the scope); in-process listeners get them all. Until these routes landed they were recorded
      `private` (#2644).

## P3 — Knowledge Base (EW-P3-2)

- [x] **T25** `work_knowledge_documents.version` + `memory_folders.version` (`AddKbAggregateVersions1795130200000`),
      `kb_document` / `kb_folder` snapshots, recording in `KnowledgeBaseService`, `KnowledgeLibraryService` and
      `MemoryFoldersService` (`kb-recording.spec.ts`), coverage gate over the KB controllers.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
