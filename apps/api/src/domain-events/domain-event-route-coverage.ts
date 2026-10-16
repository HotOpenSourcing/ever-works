/**
 * Event-coverage registry (EW-P1-1, `docs/specs/features/domain-events/spec.md` §3 "Coverage gate").
 *
 * Every mutating route (POST / PUT / PATCH / DELETE) of a controller in the
 * domain-event scope must appear here, either with the catalog events it
 * records or with the reason it records none. `domain-event-route-coverage.spec.ts`
 * reflects the routes from the controllers' Nest metadata and fails CI when a
 * route is missing from this table — so a new mutating route cannot ship
 * without someone deciding what event it records.
 *
 * The behaviour behind each `events` entry is pinned by the services' own
 * recording specs.
 */
export type RouteCoverage = { readonly events: readonly string[] } | { readonly exempt: string };

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
};

/** The routes a list of events covers (for messages). */
export function describeCoverage(coverage: RouteCoverage): string {
    return 'events' in coverage ? coverage.events.join(', ') : `exempt: ${coverage.exempt}`;
}
