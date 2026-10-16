# Task Breakdown: Record Visibility

**Feature ID**: `record-visibility`
**Last updated**: 2026-10-16

- [x] **T1** Columns + backfill migration (3 dialects) + spec. Migration `1795070000000-AddRecordVisibility`
      (sqlite spec + Postgres checked with PGlite); insert-time D11 default (entity listener + scope subscriber).
- [x] **T2** `team_resources` type `goal` (API; web in T12).
- [~] **T3** Roster backfill (pre-roster members) done; invite accept / removal already write and delete the row
  (`OrganizationInvitationFlowService.recordMembership` / `removeMember`).
- [ ] **T4** `RecordAccessPolicy` + `visibleTo(principal)`.
- [ ] **T5** Tasks list/get through the policy.
- [ ] **T6** Goals, missions, ideas, agents list/get through the policy.
- [ ] **T7** Participant / reader write rules.
- [ ] **T8** Automatic team ↔ organization scope.
- [ ] **T9** `visibility_changed` events.
- [ ] **T10** Visibility control on forms.
- [ ] **T11** Mine | Shared with me | Organization tabs.
- [ ] **T12** Goal form teams.
- [ ] **T13** Visibility matrix tests.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
