import { BadRequestException, ConflictException } from '@nestjs/common';
import { TASK_BOARD_TRANSITIONS } from '@ever-works/contracts';
import { TaskTransitionService, TASK_STATUS_TRANSITIONS } from '../task-transition.service';
import { shortestTransitionPath, TaskTransitionBlockedException } from '../task-transition-path';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

/**
 * EW-P1-6 — sync transitions and re-open.
 *
 *   - `cancelled → backlog | todo` is legal for every caller;
 *   - `shortestTransitionPath` finds the shortest legal walk between any two
 *     statuses, deterministically;
 *   - `transitionSync` walks it one gated hop at a time, refuses up front with
 *     `409 transition_blocked` (blockers, pending approvers, attempted path)
 *     and starts no agent work.
 */

const ALL = Object.values(TaskStatus) as TaskStatus[];

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Mirror me',
        description: null,
        status: TaskStatus.BACKLOG,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: null,
        parentTaskId: null,
        createdByType: 'integration',
        createdById: 'key-1',
        requireAllApprovers: true,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

describe('cancelled re-opens (EW-P1-6)', () => {
    const svc = new TaskTransitionService({} as never, {} as never, {} as never);

    it('cancelled → backlog and → todo are legal; nothing else leaves cancelled', () => {
        expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.BACKLOG)).toBe(true);
        expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.TODO)).toBe(true);
        for (const to of [
            TaskStatus.IN_PROGRESS,
            TaskStatus.IN_REVIEW,
            TaskStatus.DONE,
            TaskStatus.BLOCKED,
        ]) {
            expect(svc.canTransition(TaskStatus.CANCELLED, to)).toBe(false);
        }
    });

    it('the web board mirror equals the server lattice, re-open included', () => {
        for (const from of ALL) {
            expect([...TASK_BOARD_TRANSITIONS[from]].sort()).toEqual(
                [...TASK_STATUS_TRANSITIONS[from]].sort(),
            );
        }
    });
});

describe('shortestTransitionPath', () => {
    it('is empty for the same status and a single hop for a legal edge', () => {
        expect(
            shortestTransitionPath(TaskStatus.TODO, TaskStatus.TODO, TASK_STATUS_TRANSITIONS),
        ).toEqual([]);
        expect(
            shortestTransitionPath(
                TaskStatus.TODO,
                TaskStatus.IN_PROGRESS,
                TASK_STATUS_TRANSITIONS,
            ),
        ).toEqual([TaskStatus.IN_PROGRESS]);
    });

    it('walks backlog → done through todo and in_progress', () => {
        expect(
            shortestTransitionPath(TaskStatus.BACKLOG, TaskStatus.DONE, TASK_STATUS_TRANSITIONS),
        ).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.DONE]);
    });

    it('re-opens through cancelled when that is the only way back (done → backlog)', () => {
        expect(
            shortestTransitionPath(TaskStatus.DONE, TaskStatus.BACKLOG, TASK_STATUS_TRANSITIONS),
        ).toEqual([TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED, TaskStatus.BACKLOG]);
        expect(
            shortestTransitionPath(TaskStatus.CANCELLED, TaskStatus.DONE, TASK_STATUS_TRANSITIONS),
        ).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.DONE]);
    });

    it('reaches every status from every status, every hop legal, and is minimal (BFS distance)', () => {
        const distance = (from: TaskStatus, to: TaskStatus): number => {
            const seen = new Map<TaskStatus, number>([[from, 0]]);
            const queue = [from];
            while (queue.length) {
                const cur = queue.shift()!;
                for (const next of TASK_STATUS_TRANSITIONS[cur]) {
                    if (!seen.has(next)) {
                        seen.set(next, seen.get(cur)! + 1);
                        queue.push(next);
                    }
                }
            }
            return seen.get(to) ?? -1;
        };
        for (const from of ALL) {
            for (const to of ALL) {
                const path = shortestTransitionPath(from, to, TASK_STATUS_TRANSITIONS);
                expect(path).not.toBeNull();
                expect(path!.length).toBe(distance(from, to));
                let cursor = from;
                for (const hop of path!) {
                    expect(TASK_STATUS_TRANSITIONS[cursor]).toContain(hop);
                    cursor = hop;
                }
                expect(cursor).toBe(to);
            }
        }
    });

    it('answers null when the target is unreachable', () => {
        const closed = { ...TASK_STATUS_TRANSITIONS, [TaskStatus.CANCELLED]: [] } as Record<
            TaskStatus,
            readonly TaskStatus[]
        >;
        expect(shortestTransitionPath(TaskStatus.CANCELLED, TaskStatus.TODO, closed)).toBeNull();
    });
});

describe('TaskTransitionService.transitionSync', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let assignees: any;
    let dispatcher: any;
    let svc: TaskTransitionService;
    let row: Task;

    beforeEach(() => {
        row = makeTask();
        tasks = {
            casUpdateStatus: jest.fn(
                async (_id: string, from: TaskStatus, patch: Partial<Task>) => {
                    if (row.status !== from) return false;
                    row = { ...row, ...patch } as Task;
                    return true;
                },
            ),
            findById: jest.fn(async (id: string) => (id === row.id ? { ...row } : null)),
        };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = {
            allApproved: jest.fn().mockResolvedValue(true),
            findByTaskId: jest.fn().mockResolvedValue([]),
        };
        assignees = { findByTaskId: jest.fn().mockResolvedValue([]) };
        dispatcher = { dispatch: jest.fn() };
        svc = new TaskTransitionService(tasks, blocks, approvers, assignees, undefined, dispatcher);
    });

    it('walks backlog → done hop by hop and reports the path', async () => {
        const result = await svc.transitionSync(row, TaskStatus.DONE);
        expect(result.from).toBe(TaskStatus.BACKLOG);
        expect(result.path).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.DONE]);
        expect(result.task.status).toBe(TaskStatus.DONE);
        expect(
            tasks.casUpdateStatus.mock.calls.map((call: unknown[]) => [
                call[1],
                (call[2] as Task).status,
            ]),
        ).toEqual([
            [TaskStatus.BACKLOG, TaskStatus.TODO],
            [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
            [TaskStatus.IN_PROGRESS, TaskStatus.DONE],
        ]);
        expect(result.task.startedAt).toBeInstanceOf(Date);
        expect(result.task.completedAt).toBeInstanceOf(Date);
    });

    it('starts no agent work on the way (D9): no assignee lookup for a fan-out', async () => {
        await svc.transitionSync(row, TaskStatus.IN_PROGRESS);
        await new Promise((resolve) => setImmediate(resolve));
        expect(assignees.findByTaskId).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('is a no-op when the Task is already there', async () => {
        const result = await svc.transitionSync(row, TaskStatus.BACKLOG);
        expect(result.path).toEqual([]);
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });

    it('re-opens a cancelled Task', async () => {
        row = makeTask({ status: TaskStatus.CANCELLED });
        const result = await svc.transitionSync(row, TaskStatus.TODO);
        expect(result.path).toEqual([TaskStatus.TODO]);
        expect(result.task.status).toBe(TaskStatus.TODO);
    });

    it('refuses up front with 409 transition_blocked when a blocker is open, and moves nothing', async () => {
        blocks.findByTaskId.mockResolvedValue([{ blockedByTaskId: 'b1' }]);
        const blocker = makeTask({
            id: 'b1',
            slug: 'T-9',
            title: 'Old spike',
            status: TaskStatus.TODO,
        });
        tasks.findById.mockImplementation(async (id: string) =>
            id === 'b1' ? blocker : id === row.id ? { ...row } : null,
        );

        const err = (await svc
            .transitionSync(row, TaskStatus.DONE)
            .catch((e) => e)) as TaskTransitionBlockedException;
        expect(err).toBeInstanceOf(TaskTransitionBlockedException);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getStatus()).toBe(409);
        expect(err.getResponse()).toEqual({
            error: {
                code: 'transition_blocked',
                message: expect.stringContaining('open blocker'),
                details: {
                    from: TaskStatus.BACKLOG,
                    to: TaskStatus.DONE,
                    blockers: [
                        { taskId: 'b1', slug: 'T-9', title: 'Old spike', status: TaskStatus.TODO },
                    ],
                    pendingApprovers: [],
                    path: [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
                },
            },
        });
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });

    it('refuses up front when approvers have not approved, listing them', async () => {
        row = makeTask({ status: TaskStatus.IN_REVIEW });
        approvers.allApproved.mockResolvedValue(false);
        approvers.findByTaskId.mockResolvedValue([
            { approverType: 'user', approverId: 'u-2', approvalState: 'pending' },
            { approverType: 'agent', approverId: 'a-1', approvalState: 'rejected' },
            { approverType: 'user', approverId: 'u-3', approvalState: 'approved' },
        ]);
        const err = (await svc
            .transitionSync(row, TaskStatus.DONE)
            .catch((e) => e)) as TaskTransitionBlockedException;
        expect(err).toBeInstanceOf(TaskTransitionBlockedException);
        expect(err.details.pendingApprovers).toEqual([
            { type: 'user', id: 'u-2', state: 'pending' },
            { type: 'agent', id: 'a-1', state: 'rejected' },
        ]);
        expect(err.details.path).toEqual([TaskStatus.DONE]);
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });

    it('force skips the approver gate but never the blocker gate', async () => {
        row = makeTask({ status: TaskStatus.IN_REVIEW });
        approvers.allApproved.mockResolvedValue(false);
        await expect(
            svc.transitionSync(row, TaskStatus.DONE, { force: true }),
        ).resolves.toMatchObject({
            path: [TaskStatus.DONE],
        });

        row = makeTask({ status: TaskStatus.IN_REVIEW });
        blocks.findByTaskId.mockResolvedValue([{ blockedByTaskId: 'b1' }]);
        tasks.findById.mockImplementation(async (id: string) =>
            id === 'b1' ? makeTask({ id: 'b1', status: TaskStatus.TODO }) : { ...row },
        );
        await expect(
            svc.transitionSync(row, TaskStatus.DONE, { force: true }),
        ).rejects.toBeInstanceOf(TaskTransitionBlockedException);
    });

    it('a gate that closes mid-walk still answers 409 with the path walked so far', async () => {
        // Pre-flight passes, then the blocker appears before the in_progress hop.
        let calls = 0;
        blocks.findByTaskId.mockImplementation(async () => {
            calls += 1;
            return calls >= 2 ? [{ blockedByTaskId: 'b1' }] : [];
        });
        tasks.findById.mockImplementation(async (id: string) =>
            id === 'b1' ? makeTask({ id: 'b1', status: TaskStatus.TODO }) : { ...row },
        );
        const err = (await svc
            .transitionSync(row, TaskStatus.IN_PROGRESS)
            .catch((e) => e)) as TaskTransitionBlockedException;
        expect(err).toBeInstanceOf(TaskTransitionBlockedException);
        expect(err.details.path).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS]);
        expect(row.status).toBe(TaskStatus.TODO);
    });

    it('a lost race on a hop is the ordinary 400, not a 409', async () => {
        tasks.casUpdateStatus.mockResolvedValueOnce(false);
        await expect(svc.transitionSync(row, TaskStatus.TODO)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});
