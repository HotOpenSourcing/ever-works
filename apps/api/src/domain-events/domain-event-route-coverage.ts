/**
 * Event-coverage registry (EW-P1-1, `docs/specs/features/domain-events/spec.md` §3 "Coverage gate").
 *
 * Every mutating route (POST / PUT / PATCH / DELETE) of a controller in the
 * domain-event scope must appear here, either with the catalog events it
 * records or with the reason it records none. `domain-event-route-coverage.spec.ts`
 * reads the routes from the controllers' decorators and fails CI when a
 * route is missing from this table — so a new mutating route cannot ship
 * without someone deciding what event it records.
 *
 * The behaviour behind each `events` entry is pinned by the services' own
 * recording specs.
 */
export type RouteCoverage = { readonly events: readonly string[] } | { readonly exempt: string };

const WORK_CONTENT =
    'Content, generation, deploy or runtime state of the Work (data repository, website, schedules, items) — not part of the work integration DTO.';

/** `METHOD /full/path` → what it records. */
export const DOMAIN_EVENT_ROUTE_COVERAGE: Readonly<Record<string, RouteCoverage>> = {
    // ── Tasks (`api/tasks`) ──────────────────────────────────────────────────
    'POST /api/tasks': { events: ['task.created'] },
    'POST /api/tasks/run-batch': { events: ['task.runtime_updated'] },
    'PATCH /api/tasks/:id': { events: ['task.updated'] },
    'DELETE /api/tasks/:id': { events: ['task.deleted'] },
    'POST /api/tasks/:id/recurring': { events: ['task.updated'] },
    'POST /api/tasks/:id/recurring/run-now': { events: ['task.created'] },
    'POST /api/tasks/:id/schedule': { events: ['task.updated'] },
    'DELETE /api/tasks/:id/schedule': { events: ['task.updated'] },
    'DELETE /api/tasks/:id/recurring': { events: ['task.updated'] },
    'POST /api/tasks/:id/transition': { events: ['task.transitioned'] },
    'POST /api/tasks/:id/run': { events: ['task.runtime_updated'] },
    'POST /api/tasks/:id/resolve-conflicts': { events: ['task.transitioned'] },
    'POST /api/tasks/:id/discard-branch': { events: ['task.runtime_updated'] },
    'POST /api/tasks/:id/assignees': { events: ['task.assignee.added'] },
    'DELETE /api/tasks/:id/assignees/:assigneeId': { events: ['task.assignee.removed'] },
    'POST /api/tasks/:id/reviewers': { events: ['task.updated'] },
    'POST /api/tasks/:id/reject': { events: ['task.updated'] },
    'POST /api/tasks/:id/escalations/:escalationId/resolve': {
        exempt: 'Writes agent_escalations (the inbox domain, P3: inbox.item.*), not the task aggregate.',
    },
    'POST /api/tasks/:id/approvers': { events: ['task.updated'] },
    'POST /api/tasks/:id/blocks': { events: ['task.block.added'] },
    'DELETE /api/tasks/:id/blocks/:blockId': { events: ['task.block.removed'] },
    'POST /api/tasks/:id/attachments': { events: ['task.attachment.added'] },
    'DELETE /api/tasks/:id/attachments/:attachmentId': { events: ['task.attachment.removed'] },
    'POST /api/tasks/:id/relations': { events: ['task.relation.added'] },
    'POST /api/tasks/:id/chat': { events: ['task.comment.created'] },

    // ── Task chat (`api/task-chat-messages`) ─────────────────────────────────
    'PATCH /api/task-chat-messages/:id': { events: ['task.comment.updated'] },

    // ── Task templates (`api/task-templates`) ────────────────────────────────
    'POST /api/task-templates': {
        exempt: 'A template is not a task; nothing an integration syncs changes.',
    },
    'PATCH /api/task-templates/:id': {
        exempt: 'A template is not a task; nothing an integration syncs changes.',
    },
    'DELETE /api/task-templates/:id': {
        exempt: 'A template is not a task; nothing an integration syncs changes.',
    },
    'POST /api/task-templates/:id/instantiate': { events: ['task.created'] },
    // ── Teams (`api/organizations/:orgId`) ───────────────────────────────────
    'POST /api/organizations/:orgId/teams': { events: ['team.created'] },
    'PATCH /api/organizations/:orgId/teams/:teamId': { events: ['team.updated'] },
    'DELETE /api/organizations/:orgId/teams/:teamId': {
        // + child teams re-parented, agents / tasks / works losing the team from `teamIds`.
        events: ['team.deleted', 'team.updated', 'agent.updated', 'task.updated', 'work.updated'],
    },
    'POST /api/organizations/:orgId/teams/:teamId/members': {
        events: ['team.member.added', 'agent.updated'],
    },
    'DELETE /api/organizations/:orgId/teams/:teamId/members/:memberId': {
        events: ['team.member.removed', 'agent.updated'],
    },
    'POST /api/organizations/:orgId/teams/:teamId/resources': {
        events: ['team.resource.added', 'task.updated', 'work.updated'],
    },
    'DELETE /api/organizations/:orgId/teams/:teamId/resources/:resourceType/:resourceId': {
        events: ['team.resource.removed', 'task.updated', 'work.updated'],
    },

    // ── Organization roster (`api/organizations/:orgId`, `api/org-invite`) ──
    'POST /api/organizations/:orgId/invitations': { events: ['organization.member.added'] },
    'DELETE /api/organizations/:orgId/invitations/:invitationId': {
        exempt: 'Revokes a pending invitation; the roster (organization_members) does not change.',
    },
    'DELETE /api/organizations/:orgId/members/:userId': { events: ['organization.member.removed'] },
    'POST /api/org-invite/preview': {
        exempt: 'Read-only preview of an invitation token (POST only to keep the token out of URLs).',
    },
    'POST /api/org-invite/accept': { events: ['organization.member.added'] },

    // ── Organizations (`api/organizations`) ──────────────────────────────────
    'POST /api/organizations': {
        exempt: 'Creates an organization: catalog v1 has no organization.created (organization creation through integrations is P2, org:write).',
    },
    'POST /api/organizations/register-company': { events: ['work.created'] },
    'PATCH /api/organizations/:id': { events: ['organization.updated'] },
    'POST /api/organizations/:id/upgrade-from-account': {
        exempt: 'Bulk move of a personal account into a NEW organization (scope backfill); no v1 type covers organization creation (P2).',
    },

    // ── Agents (`api/agents`) ────────────────────────────────────────────────
    'POST /api/agents': { events: ['agent.created'] },
    'POST /api/agents/from-template/:slug': { events: ['agent.created'] },
    'PATCH /api/agents/:id': { events: ['agent.updated'] },
    'POST /api/agents/:id/targets': {
        exempt: 'Reach targets (agent_memberships) are not part of the agent integration DTO.',
    },
    'DELETE /api/agents/:id/targets/:targetType/:targetId': {
        exempt: 'Reach targets (agent_memberships) are not part of the agent integration DTO.',
    },
    'PUT /api/agents/:id/guardrails': {
        exempt: 'Guardrails are not part of the agent integration DTO.',
    },
    'DELETE /api/agents/:id': { events: ['agent.archived', 'agent.deleted'] },
    'POST /api/agents/:id/pause': { events: ['agent.status_changed'] },
    'POST /api/agents/:id/resume': { events: ['agent.status_changed'] },
    'POST /api/agents/:id/heartbeat/pause': {
        exempt: 'The heartbeat schedule is not part of the agent integration DTO.',
    },
    'POST /api/agents/:id/heartbeat/resume': {
        exempt: 'The heartbeat schedule is not part of the agent integration DTO.',
    },
    'POST /api/agents/:id/unarchive': { events: ['agent.status_changed'] },
    'PUT /api/agents/:id/files/:name': {
        exempt: "The agent's markdown files (soul, tools, heartbeat) are not part of the agent integration DTO.",
    },
    'POST /api/agents/import': {
        exempt: 'Agent bundle import (AgentExportService) records no event yet: follow-up — imported agents surface through the integration reconcile (updatedSince).',
    },
    'POST /api/agents/:id/run-now': {
        exempt: 'Starts a run (agent_runs); run state is runtime, not the agent DTO.',
    },
    'POST /api/agents/:id/runs/:runId/cancel': {
        exempt: 'Writes agent_runs (runtime), not the agent aggregate.',
    },
    'POST /api/agents/:id/runs/:runId/steer': {
        exempt: 'Writes agent_runs (runtime), not the agent aggregate.',
    },
    'POST /api/agents/:id/runs/:runId/interrupt': {
        exempt: 'Writes agent_runs (runtime), not the agent aggregate.',
    },
    'POST /api/agents/:id/runs/:runId/resume': {
        exempt: 'Writes agent_runs (runtime), not the agent aggregate.',
    },
    'POST /api/agents/:id/assign-task': {
        exempt: 'Queues an agent run for a task (agent_runs); the task records task.runtime_updated when the run is dispatched.',
    },
    'POST /api/agents/:id/attachments': {
        exempt: 'Agent attachments are not part of the agent integration DTO.',
    },
    'DELETE /api/agents/:id/attachments/:attachmentId': {
        exempt: 'Agent attachments are not part of the agent integration DTO.',
    },
    'PUT /api/agents/:id/collaborators/:collaboratorAgentId': {
        exempt: 'Agent collaborators are not part of the agent integration DTO.',
    },
    'DELETE /api/agents/:id/collaborators/:collaboratorAgentId': {
        exempt: 'Agent collaborators are not part of the agent integration DTO.',
    },

    // ── Work members (`api/works/:workId/members`) ───────────────────────────
    'POST /api/works/:workId/members': { events: ['work.member.added'] },
    'PUT /api/works/:workId/members/:memberId': { events: ['work.member.updated'] },
    'DELETE /api/works/:workId/members/:memberId': { events: ['work.member.removed'] },
    'POST /api/works/:workId/members/leave': { events: ['work.member.removed'] },

    // ── Works (`api`) ────────────────────────────────────────────────────────
    'POST /api/works': { events: ['work.created'] },
    'POST /api/works/quick-create': { events: ['work.created'] },
    'PUT /api/works/:id': { events: ['work.updated'] },
    'PATCH /api/works/:id': { events: ['work.updated'] },
    'POST /api/works/:id/delete': { events: ['work.deleted'] },
    'POST /api/works/import': { events: ['work.created'] },
    'POST /api/works/:id/activity-sync/rotate-secret': { exempt: WORK_CONTENT },
    'POST /api/works/:id/import-items/validate': { exempt: WORK_CONTENT },
    'POST /api/works/:id/import-items': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/website-settings': { exempt: WORK_CONTENT },
    'POST /api/works/generate-details': { exempt: WORK_CONTENT },
    'POST /api/works/:id/generate': { exempt: WORK_CONTENT },
    'POST /api/works/:id/update': { exempt: WORK_CONTENT },
    'POST /api/works/:id/cancel-generation': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/schedule': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/schedule': { exempt: WORK_CONTENT },
    'POST /api/works/:id/schedule/run': { exempt: WORK_CONTENT },
    'POST /api/works/:id/submit-item': { exempt: WORK_CONTENT },
    'POST /api/works/:id/remove-item': { exempt: WORK_CONTENT },
    'POST /api/works/:id/update-item': { exempt: WORK_CONTENT },
    'POST /api/works/:id/check-item-health': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/source-validation': { exempt: WORK_CONTENT },
    'POST /api/extract-item-details': { exempt: WORK_CONTENT },
    'POST /api/works/:id/bulk-capture-images': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/domain-type': { exempt: WORK_CONTENT },
    'POST /api/works/:id/regenerate-markdown': { exempt: WORK_CONTENT },
    'POST /api/works/:id/update-readme': { exempt: WORK_CONTENT },
    'POST /api/works/:id/update-website': { exempt: WORK_CONTENT },
    'POST /api/works/:id/switch-website-template': { exempt: WORK_CONTENT },
    'POST /api/works/:id/sync-data': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/repositories/visibility': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/advanced-prompts': { exempt: WORK_CONTENT },
    'POST /api/works/import/analyze': { exempt: WORK_CONTENT },
    'POST /api/works/import/analyze-for-linking': { exempt: WORK_CONTENT },
    'POST /api/works/:id/categories': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/categories/:categoryId': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/categories/:categoryId': { exempt: WORK_CONTENT },
    'POST /api/works/:id/tags': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/tags/:tagId': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/tags/:tagId': { exempt: WORK_CONTENT },
    'POST /api/works/:id/collections': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/collections/:collectionId': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/collections/:collectionId': { exempt: WORK_CONTENT },
    'POST /api/works/:id/process-community-prs': { exempt: WORK_CONTENT },
    'POST /api/works/:id/comparisons/generate': { exempt: WORK_CONTENT },
    'POST /api/works/:id/comparisons/generate-manual': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/comparisons/:slug': { exempt: WORK_CONTENT },

    // ── Integration API v1 (`api/integrations/v1`, EW-P1-4) ───────────────────
    'POST /api/integrations/v1/tasks': {
        // + extra teamIds as team resources, assignees as edges.
        events: ['task.created', 'team.resource.added', 'task.updated', 'task.assignee.added'],
    },
    'PATCH /api/integrations/v1/tasks/:id': {
        events: ['task.updated', 'team.resource.added', 'team.resource.removed'],
    },
    'DELETE /api/integrations/v1/tasks/:id': { events: ['task.deleted'] },
    'PUT /api/integrations/v1/tasks/:id/assignees': {
        events: ['task.assignee.added', 'task.assignee.removed'],
    },
    'PUT /api/integrations/v1/tasks/:id/watchers': {
        events: ['task.watcher.added', 'task.watcher.removed'],
    },
    'PUT /api/integrations/v1/tasks/:id/blocks': {
        events: ['task.block.added', 'task.block.removed'],
    },
    'PUT /api/integrations/v1/tasks/:id/relations': {
        events: ['task.relation.added', 'task.relation.removed'],
    },
    // + `task.comment.deleted` when a concurrent create won the externalRef.
    'POST /api/integrations/v1/tasks/:id/comments': {
        events: ['task.comment.created', 'task.comment.deleted'],
    },
    'PATCH /api/integrations/v1/tasks/:id/comments/:cid': { events: ['task.comment.updated'] },
    'DELETE /api/integrations/v1/tasks/:id/comments/:cid': { events: ['task.comment.deleted'] },
};

/** The routes a list of events covers (for messages). */
export function describeCoverage(coverage: RouteCoverage): string {
    return 'events' in coverage ? coverage.events.join(', ') : `exempt: ${coverage.exempt}`;
}
