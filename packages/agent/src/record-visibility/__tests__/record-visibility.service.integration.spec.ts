import { randomUUID } from 'crypto';
import {
    BadRequestException,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource, type ObjectLiteral, type Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { DomainEventRecorder } from '../../domain-events/domain-event-recorder.service';
import { buildTaskSnapshot } from '../../domain-events/domain-event-snapshots';
import { DomainEvent } from '../../entities/domain-event.entity';
import { Goal } from '../../entities/goal.entity';
import { Organization } from '../../entities/organization.entity';
import { Task } from '../../entities/task.entity';
import { Team } from '../../entities/team.entity';
import { TeamResource } from '../../entities/team-resource.entity';
import { Tenant } from '../../entities/tenant.entity';
import { User } from '../../entities/user.entity';
import { RecordVisibilitySubscriber } from '../../entities/_record-visibility';
import {
    PrivateVisibilityForbiddenError,
    RecordVisibilityService,
} from '../record-visibility.service';

/**
 * Record visibility writes (EW-P1-3, `docs/specs/features/record-visibility/spec.md` §5,
 * §9): the automatic Team ↔ Organization changes, `visibilityExplicit`, the integration
 * rules and `<aggregate>.visibility_changed` through the REAL domain-event recorder, on
 * better-sqlite3 with the full schema (and the insert-time subscriber registered).
 */
describe('RecordVisibilityService (better-sqlite3)', () => {
    let dataSource: DataSource;
    let service: RecordVisibilityService;
    const ids = {
        user: '',
        tenant: '',
        org: '',
        otherOrg: '',
        team: '',
        team2: '',
        foreignTeam: '',
    };
    let slug = 0;

    const repo = <T extends ObjectLiteral>(entity: new () => T): Repository<T> =>
        dataSource.getRepository(entity);

    async function newTask(fields: Partial<Task> = {}): Promise<Task> {
        slug += 1;
        return repo(Task).save(
            repo(Task).create({
                userId: ids.user,
                slug: `T-${slug}`,
                title: `Task ${slug}`,
                createdByType: 'user',
                createdById: ids.user,
                tenantId: ids.tenant,
                organizationId: ids.org,
                ...fields,
            } as Partial<Task>),
        );
    }

    async function events(aggregateId: string): Promise<DomainEvent[]> {
        return repo(DomainEvent).find({
            where: { aggregateId },
            order: { outboxSeq: 'ASC' } as never,
        });
    }

    async function reload(id: string): Promise<Task> {
        return (await repo(Task).findOne({ where: { id } }))!;
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            subscribers: [RecordVisibilitySubscriber],
            synchronize: true,
        });
        await dataSource.initialize();
        const user = await repo(User).save(
            repo(User).create({
                username: `owner-${randomUUID().slice(0, 8)}`,
                email: `owner-${randomUUID().slice(0, 8)}@example.com`,
                password: 'x',
            } as Partial<User>),
        );
        ids.user = user.id;
        const tenant = await repo(Tenant).save(
            repo(Tenant).create({
                ownerUserId: user.id,
                slug: 'acme',
                displayName: 'Acme',
            } as Partial<Tenant>),
        );
        ids.tenant = tenant.id;
        for (const [key, s] of [
            ['org', 'acme-org'],
            ['otherOrg', 'acme-other'],
        ] as const) {
            const org = await repo(Organization).save(
                repo(Organization).create({
                    tenantId: tenant.id,
                    slug: s,
                    displayName: s,
                } as Partial<Organization>),
            );
            ids[key] = org.id;
        }
        for (const [key, org, s] of [
            ['team', ids.org, 'core'],
            ['team2', ids.org, 'growth'],
            ['foreignTeam', ids.otherOrg, 'elsewhere'],
        ] as const) {
            const team = await repo(Team).save(
                repo(Team).create({
                    userId: ids.user,
                    name: s,
                    slug: s,
                    tenantId: tenant.id,
                    organizationId: org,
                } as Partial<Team>),
            );
            ids[key] = team.id;
        }
        service = new RecordVisibilityService(dataSource, new DomainEventRecorder());
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    describe('insert-time default (DataSource subscriber)', () => {
        it('an org Task starts organization, one created on a Team starts team, a personal one private', async () => {
            expect((await newTask()).visibility).toBe('organization');
            expect((await newTask({ teamId: ids.team })).visibility).toBe('team');
            expect((await newTask({ organizationId: null })).visibility).toBe('private');
        });
    });

    describe('automatic Team ↔ Organization (visibilityExplicit = false)', () => {
        it('the first Team narrows organization → team, the last leaving widens it back, each recording an event', async () => {
            const task = await newTask();
            const attach = await repo(TeamResource).save(
                repo(TeamResource).create({
                    teamId: ids.team,
                    resourceType: 'task',
                    resourceId: task.id,
                    tenantId: ids.tenant,
                    organizationId: ids.org,
                    createdAt: new Date(),
                }),
            );
            await service.recomputeAutomatic('task', task.id);
            expect((await reload(task.id)).visibility).toBe('team');

            await repo(TeamResource).delete({ id: attach.id });
            await service.recomputeAutomatic('task', task.id);
            const after = await reload(task.id);
            expect(after.visibility).toBe('organization');
            expect(after.visibilityExplicit).toBe(false);

            const recorded = await events(task.id);
            expect(recorded.map((event) => event.type)).toEqual([
                'task.visibility_changed',
                'task.visibility_changed',
            ]);
            expect(recorded[0].data).toEqual(
                expect.objectContaining({ id: task.id, visibility: 'team', teamIds: [ids.team] }),
            );
            expect(recorded[0].previous).toEqual({ visibility: 'organization' });
            expect(recorded[1].aggregateVersion).toBeGreaterThan(recorded[0].aggregateVersion);
            expect(after.version).toBe(recorded[1].aggregateVersion);
        });

        it('a recompute with nothing to change records nothing', async () => {
            const task = await newTask();
            await service.recomputeAutomatic('task', task.id);
            expect(await events(task.id)).toEqual([]);
        });

        it('a hand-picked visibility never changes on its own', async () => {
            const task = await newTask();
            await service.setVisibility('task', task.id, 'organization');
            await service.setTeams('task', task.id, [ids.team], ids.user);
            const after = await reload(task.id);
            expect(after.visibility).toBe('organization');
            expect(after.visibilityExplicit).toBe(true);
        });

        it('a personal record never moves', async () => {
            const task = await newTask({ organizationId: null, teamId: ids.team });
            await service.recomputeAutomatic('task', task.id);
            expect((await reload(task.id)).visibility).toBe('private');
        });
    });

    describe('by hand (setVisibility)', () => {
        it('private by hand: explicit, and the event carries ONLY {id, visibility}', async () => {
            const task = await newTask({ teamId: ids.team });
            const state = await service.setVisibility('task', task.id, 'private');
            expect(state).toEqual({
                visibility: 'private',
                visibilityExplicit: true,
                teamIds: [ids.team],
            });
            const [event] = await events(task.id);
            expect(event.type).toBe('task.visibility_changed');
            expect(event.data).toEqual({ id: task.id, visibility: 'private' });
            expect(event.visibility).toBe('private');
        });

        it('automatic hands the choice back to D11 and clears the explicit flag', async () => {
            const task = await newTask({ teamId: ids.team });
            await service.setVisibility('task', task.id, 'private');
            const state = await service.setVisibility('task', task.id, 'automatic');
            expect(state).toEqual(
                expect.objectContaining({ visibility: 'team', visibilityExplicit: false }),
            );
        });

        it('a personal record takes private / automatic only', async () => {
            const task = await newTask({ organizationId: null });
            await expect(service.setVisibility('task', task.id, 'team')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.setVisibility('task', task.id, 'automatic')).resolves.toEqual(
                expect.objectContaining({ visibility: 'private', visibilityExplicit: false }),
            );
        });

        it('rejects an unknown value and answers null for a missing record', async () => {
            const task = await newTask();
            await expect(
                service.setVisibility('task', task.id, 'public' as never),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(service.setVisibility('task', randomUUID(), 'team')).resolves.toBeNull();
        });
    });

    describe('Teams as one set (setTeams — integration teamIds[], the goal form)', () => {
        it('a Task stores the first as teamId and the rest as team_resources; an empty set clears both', async () => {
            const task = await newTask();
            const state = await service.setTeams('task', task.id, [ids.team, ids.team2], ids.user);
            expect(state).toEqual({
                visibility: 'team',
                visibilityExplicit: false,
                teamIds: [ids.team, ids.team2],
            });
            expect((await reload(task.id)).teamId).toBe(ids.team);
            expect(
                (await repo(TeamResource).find({ where: { resourceId: task.id } })).map(
                    (r) => r.teamId,
                ),
            ).toEqual([ids.team2]);

            const cleared = await service.setTeams('task', task.id, [], ids.user);
            expect(cleared).toEqual({
                visibility: 'organization',
                visibilityExplicit: false,
                teamIds: [],
            });
            expect((await reload(task.id)).teamId).toBeNull();
        });

        it('a Goal sits on Teams through team_resources (type goal) and narrows to team', async () => {
            const goal = await repo(Goal).save(
                repo(Goal).create({
                    userId: ids.user,
                    title: 'Grow',
                    window: 'total',
                    tenantId: ids.tenant,
                    organizationId: ids.org,
                } as Partial<Goal>),
            );
            expect(goal.visibility).toBe('organization');
            const state = await service.setTeams('goal', goal.id, [ids.team], ids.user);
            expect(state).toEqual({
                visibility: 'team',
                visibilityExplicit: false,
                teamIds: [ids.team],
            });
            const rows = await repo(TeamResource).find({ where: { resourceId: goal.id } });
            expect(rows.map((row) => [row.resourceType, row.teamId])).toEqual([['goal', ids.team]]);
            // Goals carry no `version` column yet: their visibility_changed records in P2.
            expect(await events(goal.id)).toEqual([]);
        });

        it('a Team of another Organization is a 404 and changes nothing', async () => {
            const task = await newTask();
            await expect(
                service.setTeams('task', task.id, [ids.foreignTeam], ids.user),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect((await reload(task.id)).teamId).toBeNull();
        });

        it('records of a Team are found for the post-delete recompute', async () => {
            const task = await newTask({ teamId: ids.team2 });
            const records = await service.recordsOfTeam(ids.team2);
            expect(records).toEqual(expect.arrayContaining([{ aggregate: 'task', id: task.id }]));
        });
    });

    describe('domain-event snapshots read the stored visibility (EW-P1-1 B2)', () => {
        it('a private Task snapshots as private (kept out of the feed), explicit flag included', async () => {
            const task = await newTask({ teamId: ids.team });
            await service.setVisibility('task', task.id, 'private');
            const snapshot = await buildTaskSnapshot(dataSource.manager, task.id);
            expect(snapshot?.dto).toEqual(
                expect.objectContaining({ visibility: 'private', visibilityExplicit: true }),
            );
        });

        it('a team / organization change carries the full integration DTO', async () => {
            const task = await newTask();
            await service.setVisibility('task', task.id, 'team');
            const [event] = await events(task.id);
            expect(event.data).toEqual(
                expect.objectContaining({
                    id: task.id,
                    visibility: 'team',
                    visibilityExplicit: true,
                    title: task.title,
                    owner: { type: 'user', id: ids.user },
                }),
            );
            expect(event.visibility).toBe('team');
        });
    });

    describe('integration principal rules', () => {
        it('private → 422 domain_rule; team / organization pass; anything else 400', () => {
            expect(() => RecordVisibilityService.assertIntegrationVisibility('private')).toThrow(
                PrivateVisibilityForbiddenError,
            );
            try {
                RecordVisibilityService.assertIntegrationVisibility('private');
            } catch (error) {
                expect(error).toBeInstanceOf(UnprocessableEntityException);
                expect((error as UnprocessableEntityException).getResponse()).toEqual(
                    expect.objectContaining({
                        error: expect.objectContaining({ code: 'domain_rule' }),
                    }),
                );
            }
            expect(() => RecordVisibilityService.assertIntegrationVisibility('team')).not.toThrow();
            expect(() =>
                RecordVisibilityService.assertIntegrationVisibility('organization'),
            ).not.toThrow();
            expect(() => RecordVisibilityService.assertIntegrationVisibility('automatic')).toThrow(
                BadRequestException,
            );
        });
    });
});
