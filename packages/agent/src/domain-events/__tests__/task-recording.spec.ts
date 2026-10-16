import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { TaskRepository } from '../../database/repositories/task.repository';
import {
    TaskApproverRepository,
    TaskAssigneeRepository,
    TaskAttachmentRepository,
    TaskBlockRepository,
    TaskChatMessageRepository,
    TaskKbMentionRepository,
    TaskRelationRepository,
    TaskReviewerRepository,
    UserTaskCounterRepository,
} from '../../database/repositories/task-side.repositories';
import type { OwnershipScope } from '../../database/ownership-scope';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Task, TaskStatus } from '../../entities/task.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import { TaskAttachment } from '../../entities/task-attachment.entity';
import { TaskBlock } from '../../entities/task-block.entity';
import { TaskChatMessage } from '../../entities/task-chat-message.entity';
import { TaskKbMention } from '../../entities/task-kb-mention.entity';
import { TaskRelation } from '../../entities/task-relation.entity';
import { TaskReviewer } from '../../entities/task-reviewer.entity';
import { TeamResource } from '../../entities/team-resource.entity';
import { UserTaskCounter } from '../../entities/user-task-counter.entity';
import { TaskChatService } from '../../tasks-domain/task-chat.service';
import { TaskRunDenormService } from '../../tasks-domain/task-run-denorm.service';
import { TaskTransitionService } from '../../tasks-domain/task-transition.service';
import { TasksService } from '../../tasks-domain/tasks.service';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import { describeTaskPatchIn } from '../domain-event-task-fields';
import {
    contractValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Task recording points (EW-P1-1 B2, spec §3–4): the real services, wired
 * the way Nest wires them, on SQLite — every write records its `task.*`
 * event, bumps the version as the spec says, and the event `data` is a valid
 * integration DTO.
 */
describe('task recording points', () => {
    let dataSource: DataSource;
    let tasks: TasksService;
    let chat: TaskChatService;
    let denorm: TaskRunDenormService;
    let plainTasks: TasksService;
    const expectValid = contractValidator();
    const OWNER = randomUUID();
    const AGENT = randomUUID();
    const scope = { tenantId: TENANT, organizationId: ORG_A } as unknown as OwnershipScope;

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });
    const versionOf = async (id: string) =>
        Number((await dataSource.getRepository(Task).findOneByOrFail({ id })).version);

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        const taskRepo = new TaskRepository(dataSource.getRepository(Task));
        const assignees = new TaskAssigneeRepository(dataSource.getRepository(TaskAssignee));
        const reviewers = new TaskReviewerRepository(dataSource.getRepository(TaskReviewer));
        const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
        const blocks = new TaskBlockRepository(dataSource.getRepository(TaskBlock));
        const relations = new TaskRelationRepository(dataSource.getRepository(TaskRelation));
        const counter = new UserTaskCounterRepository(dataSource.getRepository(UserTaskCounter));
        const attachments = new TaskAttachmentRepository(dataSource.getRepository(TaskAttachment));
        const publisher = new DomainEventPublisher(new DomainEventRecorder(), dataSource);
        const u = undefined;
        const transitions = new TaskTransitionService(
            taskRepo,
            blocks,
            approvers,
            assignees,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            publisher,
        );
        tasks = new TasksService(
            taskRepo,
            assignees,
            reviewers,
            approvers,
            blocks,
            relations,
            counter,
            transitions,
            u,
            attachments,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            publisher,
        );
        // The same graph WITHOUT the publisher: today's behaviour, no events.
        const plainTransitions = new TaskTransitionService(taskRepo, blocks, approvers, assignees);
        plainTasks = new TasksService(
            taskRepo,
            assignees,
            reviewers,
            approvers,
            blocks,
            relations,
            counter,
            plainTransitions,
        );
        chat = new TaskChatService(
            taskRepo,
            new TaskChatMessageRepository(dataSource.getRepository(TaskChatMessage)),
            new TaskKbMentionRepository(dataSource.getRepository(TaskKbMention)),
            u,
            u,
            u,
            u,
            u,
            publisher,
        );
        denorm = new TaskRunDenormService(taskRepo, publisher);
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of [
            'tasks',
            'task_assignees',
            'task_blocks',
            'task_relations',
            'task_chat_messages',
            'user_task_counter',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const newTask = (title = 'Ship the feed') =>
        tasks.create(OWNER, { title, createdByType: 'user', createdById: OWNER }, scope);

    it('create records task.created at version 1 with a valid task DTO', async () => {
        const task = await newTask();
        const [event] = await events();
        expect(event).toMatchObject({
            type: 'task.created',
            aggregateType: 'task',
            aggregateId: task.id,
            aggregateVersion: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
            changedFields: [],
        });
        expect(event.data).toMatchObject({
            id: task.id,
            title: 'Ship the feed',
            status: 'backlog',
            version: 1,
        });
        expectValid('resources/task.schema.json', event.data);
    });

    it('update records task.updated with the changed DTO fields and their previous values', async () => {
        const task = await newTask();
        await tasks.update(OWNER, task.id, { title: 'Ship the feed v2', labels: ['gauzy'] }, scope);
        const updated = (await events()).find((event) => event.type === 'task.updated');
        expect(updated).toMatchObject({ aggregateVersion: 2 });
        expect(updated?.changedFields.sort()).toEqual(['labels', 'title']);
        expect(updated?.previous).toEqual({ title: 'Ship the feed', labels: null });
        expect(updated?.data).toMatchObject({
            title: 'Ship the feed v2',
            labels: ['gauzy'],
            version: 2,
        });
        expect(await versionOf(task.id)).toBe(2);
    });

    it('transition records task.transitioned with the previous status', async () => {
        const task = await newTask();
        await tasks.transition(OWNER, task.id, TaskStatus.TODO, {}, scope);
        const transitioned = (await events()).find((event) => event.type === 'task.transitioned');
        expect(transitioned).toMatchObject({
            changedFields: ['status'],
            previous: { status: 'backlog' },
            aggregateVersion: 2,
        });
        expect(transitioned?.data).toMatchObject({ status: 'todo' });
    });

    it('a transition that stamps startedAt names it among the changed fields', async () => {
        const task = await newTask();
        await tasks.transition(OWNER, task.id, TaskStatus.TODO, {}, scope);
        await tasks.transition(OWNER, task.id, TaskStatus.IN_PROGRESS, {}, scope);
        const started = (await events()).filter((event) => event.type === 'task.transitioned')[1];
        expect(started).toMatchObject({
            changedFields: ['status', 'startedAt'],
            previous: { status: 'todo', startedAt: null },
            aggregateVersion: 3,
        });
        expect((started.data as { startedAt: string | null }).startedAt).toEqual(
            expect.any(String),
        );
    });

    it('a teamId change reports the previous teamIds as the DTO had them (teamId + links)', async () => {
        const task = await newTask();
        const [teamA, teamB, linked] = [randomUUID(), randomUUID(), randomUUID()];
        await dataSource.getRepository(TeamResource).insert({
            teamId: linked,
            resourceType: 'task',
            resourceId: task.id,
            addedById: OWNER,
            createdAt: new Date(),
        } as unknown as TeamResource);
        const described = await describeTaskPatchIn(
            dataSource.manager,
            task.id,
            { teamId: teamB },
            { teamId: teamA },
        );
        expect(described).toEqual({
            changedFields: ['teamIds'],
            previous: { teamIds: [teamA, linked] },
        });
        await dataSource.getRepository(TeamResource).delete({ resourceId: task.id });
    });

    it('edges record child events that bump the parent version and carry the child', async () => {
        const task = await newTask();
        const other = await newTask('Blocker');
        const assignee = await tasks.addAssignee(OWNER, task.id, 'agent', AGENT, scope);
        await tasks.addBlocker(OWNER, task.id, other.id, scope);
        await tasks.addRelation(OWNER, task.id, other.id, 'related', scope);
        await tasks.removeAssignee(OWNER, task.id, assignee.id, scope);

        const child = (await events()).filter(
            (event) => event.aggregateId === task.id && event.type !== 'task.created',
        );
        expect(child.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['task.assignee.added', 2],
            ['task.block.added', 3],
            ['task.relation.added', 4],
            ['task.assignee.removed', 5],
        ]);
        expect(child[0].data).toEqual({ taskId: task.id, type: 'agent', id: AGENT });
        expect(child[0].changedFields).toEqual(['assignees']);
        expect(child[1].data).toEqual({ taskId: task.id, blockedByTaskId: other.id });
        expect(child[3].data).toEqual({ taskId: task.id, type: 'agent', id: AGENT, deleted: true });
        expect(await versionOf(task.id)).toBe(5);
    });

    it('a refused write (409 duplicate assignee) records nothing', async () => {
        const task = await newTask();
        await tasks.addAssignee(OWNER, task.id, 'agent', AGENT, scope);
        const before = (await events()).length;
        await expect(tasks.addAssignee(OWNER, task.id, 'agent', AGENT, scope)).rejects.toThrow(
            /already has assignee/,
        );
        expect((await events()).length).toBe(before);
        expect(await versionOf(task.id)).toBe(2);
    });

    it('delete records task.deleted with the last snapshot, deleted: true, at a version claimed first', async () => {
        const task = await newTask();
        await tasks.update(OWNER, task.id, { title: 'Doomed' }, scope);
        await tasks.remove(OWNER, task.id, scope);
        const deleted = (await events()).find((event) => event.type === 'task.deleted');
        expect(deleted).toMatchObject({ aggregateVersion: 3 });
        expect(deleted?.data).toMatchObject({
            id: task.id,
            title: 'Doomed',
            version: 3,
            deleted: true,
        });
        expectValid('resources/task.schema.json', deleted?.data);
    });

    it('chat records task.comment.created / .updated with a valid comment DTO', async () => {
        const task = await newTask();
        const message = await chat.post(
            OWNER,
            { taskId: task.id, authorType: 'user', authorId: OWNER, body: 'First!' },
            {},
            scope,
        );
        await chat.edit(OWNER, message.id, 'First (edited)', {}, scope);
        const comments = (await events()).filter((event) => event.type.startsWith('task.comment.'));
        expect(comments.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['task.comment.created', 2],
            ['task.comment.updated', 3],
        ]);
        expect(comments[1].data).toMatchObject({ id: message.id, body: 'First (edited)' });
        expect(comments[1].previous).toEqual({ body: 'First!' });
        for (const comment of comments)
            expectValid('resources/task-comment.schema.json', comment.data);
    });

    it('a runtime-only write records task.runtime_updated and bumps neither version nor updatedAt', async () => {
        const task = await newTask();
        const before = await dataSource.getRepository(Task).findOneByOrFail({ id: task.id });
        await denorm.recordQueued(task.id, randomUUID());
        const runtime = (await events()).find((event) => event.type === 'task.runtime_updated');
        expect(runtime).toMatchObject({ aggregateVersion: 1, changedFields: ['runtime'] });
        expect(runtime?.data).toMatchObject({ runtime: { latestRunStatus: 'queued' } });
        const after = await dataSource.getRepository(Task).findOneByOrFail({ id: task.id });
        expect(after.version).toBe(1);
        expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
    });

    it('without the publisher the services behave as before and record nothing', async () => {
        const task = await plainTasks.create(
            OWNER,
            { title: 'Quiet', createdByType: 'user', createdById: OWNER },
            scope,
        );
        await plainTasks.update(OWNER, task.id, { title: 'Still quiet' }, scope);
        await plainTasks.addAssignee(OWNER, task.id, 'agent', AGENT, scope);
        expect(await events()).toEqual([]);
        expect(await versionOf(task.id)).toBe(1);
    });
});
