import type { Task } from '../entities/task.entity';

/**
 * Task entity column → integration DTO field (integration contract v1, B.6).
 * Columns not listed are not part of the DTO (runtime, schedule and
 * plumbing columns): a change to them still bumps the version but names no
 * changed field.
 */
const TASK_COLUMN_TO_DTO_FIELD: Readonly<Partial<Record<keyof Task, string>>> = {
    title: 'title',
    description: 'description',
    status: 'status',
    priority: 'priority',
    labels: 'labels',
    workId: 'workId',
    missionId: 'missionId',
    ideaId: 'ideaId',
    goalId: 'goalId',
    agentId: 'agentId',
    teamId: 'teamIds',
    parentTaskId: 'parentTaskId',
    startedAt: 'startedAt',
    completedAt: 'completedAt',
    hiddenFromBoard: 'hiddenFromBoard',
    isRecurring: 'isRecurringTemplate',
};

const toEventValue = (value: unknown): unknown =>
    value instanceof Date ? value.toISOString() : (value ?? null);

/**
 * `changedFields` and `previous` of a `task.updated` event for a patch about to
 * be written to `before`. `teamId` is reported as `teamIds`, whose previous
 * value is the old `teamId` as a one-element set (team resources are separate
 * edges).
 */
export function describeTaskPatch(
    patch: Partial<Task>,
    before?: Partial<Task> | null,
): { changedFields: string[]; previous: Record<string, unknown> } {
    const changedFields: string[] = [];
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as Array<keyof Task>) {
        const field = TASK_COLUMN_TO_DTO_FIELD[key];
        if (!field || changedFields.includes(field)) continue;
        if (
            before &&
            JSON.stringify(toEventValue(before[key])) === JSON.stringify(toEventValue(patch[key]))
        ) {
            continue;
        }
        changedFields.push(field);
        if (before) {
            previous[field] =
                key === 'teamId'
                    ? before.teamId
                        ? [before.teamId]
                        : []
                    : toEventValue(before[key]);
        }
    }
    return { changedFields, previous };
}
