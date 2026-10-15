# Feature Specification: Record Visibility

**Feature ID**: `record-visibility`
**Status**: `Draft` (EW-P1-3)
**Created**: 2026-10-15
**Last updated**: 2026-10-15
**Owner**: Product (Ruslan)

> **Problem.** Tasks, goals, missions, ideas and agents are private to their owner: every list filters on
> `userId = caller` (`task.repository.ts`, `ownership-scope.ts`), so two members of one organization never see each
> other's tasks, and a user assigned to a task cannot even list it. Only Teams are org-wide. An organization-level
> integration (Ever Gauzy) has no shared view to sync.
>
> **Owner decisions.** D6: keep today's per-user ownership and **add** visibility through the org, teams, works and
> participants. D11 (2026-10-15): a record attached to a Team is team-scoped; a record with no team is organization-scoped
> — for new **and existing** org records, applied automatically by the migration, with no opt-in and no "share" action.
> Owners can still mark a record `private`.
>
> **Hard rule (additive only):** the owner keeps every right they have today; `Mine` stays the default tab.

---

## 1. Columns

- `visibility varchar(16) NOT NULL DEFAULT 'private'` (`private` | `team` | `organization`) and
  `visibilityExplicit boolean NOT NULL DEFAULT false` on `tasks`, `goals`, `missions`, `work_proposals` and `agents`.
- `team_resources.resourceType` gains `goal`, so goals can sit on a team like every other resource (goal form shows
  and edits its teams).

## 2. Backfill (same migration)

- Every existing **org-scope** row (`organizationId IS NOT NULL`): `team` if it sits on a team (`teamId`,
  `team_resources`, or for agents a team membership), otherwise `organization`; `visibilityExplicit = false`.
- Personal-scope rows (`organizationId IS NULL`) stay `private`.
- **Roster backfill**: insert an `organization_members` row for every active user whose `tenantId` matches the org's
  tenant. They already have tenant-wide access (a user joins a tenant only by accepting an organization invitation, and
  `organization-membership.service.ts` authorizes on `user.tenantId === org.tenantId`), so access does not change. The
  roster only records that existing membership; it grants no permission by itself, and it is not what authorizes a
  write — an integration's act-as user still passes that user's own permission checks for every operation
  ([`integration-keys`](../integration-keys/spec.md) §2).

## 3. Who can read an org-scoped record

1. **`private`**: the **owner** (today's rule) and the **participants** — task assignees, approvers, reviewers and
   watchers.
2. **`team`**: also the **members of the record's teams** (`teamId` and `team_resources`) and of its Work
   (`work_members`).
3. **`organization`**: also every member of the org (roster).

## 4. Who can write

- Writes stay with the owner and the existing role rules.
- Participants may comment and transition, as the existing assignee rules allow.
- Connected-group and org readers may comment.

## 5. Defaults and automatic scope

- **New records in an org scope**: `team` when created with a team, otherwise `organization`. Personal-scope records
  stay `private`.
- **While `visibilityExplicit = false`**: adding the first team narrows `organization` → `team`; removing the last team
  widens `team` → `organization`.
- Choosing a visibility by hand sets `visibilityExplicit = true` and stops automatic changes. `private` is only ever set
  by hand.
- **Integration writes** may set `team` or `organization` (`422 domain_rule` for `private`) and send `teamIds[]`, stored
  as `teamId` (first) plus `team_resources` (rest).

## 6. Organization roster

`organization_members` becomes the source of truth for "member of the org": kept in sync on invite accept and on
removal (removal emits `organization.member.removed`).

## 7. UI

- A visibility control (lock / team / org icon) on the task, goal, mission, idea and agent forms. It shows
  "Automatic" until the user picks a value.
- List tabs **Mine | Shared with me | Organization** on `/tasks`, `/goals`, `/missions`, `/ideas` and `/agents`; `Mine`
  stays the default.

## 8. Implementation shape

One `RecordAccessPolicy` service plus a repository helper `visibleTo(principal)`. Every list and get path goes through
it, replacing the scattered `userId = caller` filters; each replaced filter becomes a test case. The integration
principal reads every row in its pinned orgs with `visibility` `team` or `organization`.

## 9. Events

A change of visibility records `<aggregate>.visibility_changed` ([`domain-events`](../domain-events/spec.md)). A change
**to** `private` carries only `{id, visibility:'private'}` so consumers stop syncing without seeing the content.

## 10. Acceptance criteria

- [ ] Visibility matrix: owner, participant, team member, work member, org member, outsider, integration principal ×
      `private` / `team` / `organization`.
- [ ] Automatic team ↔ organization changes while `visibilityExplicit = false`, none after a manual choice.
- [ ] Existing org rows are `team`/`organization` after the migration; personal rows stay `private`; `down` reverts.
- [ ] `Mine` lists exactly what it lists today.
