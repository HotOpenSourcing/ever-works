# Task Breakdown: Record Visibility

**Feature ID**: `record-visibility`
**Last updated**: 2026-10-16

- [x] **T1** Columns + backfill migration (3 dialects) + spec. Migration `1795070000000-AddRecordVisibility`
      (sqlite spec + Postgres checked with PGlite); insert-time D11 default (DataSource subscriber + scope subscriber).
- [x] **T2** `team_resources` type `goal` (API; web in T12).
- [~] **T3** Roster backfill (pre-roster members) done; invite accept / removal already write and delete the row
  (`OrganizationInvitationFlowService.recordMembership` / `removeMember`).
- [x] **T4** `RecordAccessPolicy` + `visibleTo(principal)` (`packages/agent/src/record-visibility/`).
- [x] **T5** Tasks list/board/get through the policy (`?view=`, `getReadable`).
- [x] **T6** Goals, missions, ideas, agents list/get through the policy.
- [x] **T7** Participant transition, reader comments (no agent dispatch for non-owners).
- [ ] **T8** Automatic team ↔ organization scope.
- [ ] **T9** `visibility_changed` events.
- [ ] **T10** Visibility control on forms.
- [ ] **T11** Mine | Shared with me | Organization tabs.
- [ ] **T12** Goal form teams.
- [~] **T13** Visibility matrix tests: read matrix (7 principals × 3 visibilities × 5 aggregates + integration)
  done; automatic changes with T8.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
