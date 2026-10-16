import {
    DuplicateExternalRefError,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import { IntegrationHttpException } from '../../../auth/integration/integration-http.exception';
import { IntegrationTasksWriteController } from '../tasks-write.controller';

/**
 * Task writes of `/api/integrations/v1` (EW-P1-4): Idempotency-Key, externalRef
 * de-duplication (200 with the existing task), If-Match, attribution and the
 * visibility rule — over doubles of the domain services.
 */
describe('IntegrationTasksWriteController', () => {
    const ORG = 'org-1';
    const principal = {
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: [ORG],
        scopes: ['tasks:write'],
        ownerUserId: 'owner-1',
        actAsUserId: null,
    };
    const user = { userId: 'owner-1', authMethod: 'integration', integration: principal } as never;
    const req = (key: string | undefined = 'idem-1', body: unknown = {}) => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/tasks',
        body,
        headers: key ? { 'idempotency-key': key } : {},
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });

    const setup = () => {
        const tasks = {
            create: jest.fn().mockResolvedValue({ id: 'task-1' }),
            update: jest.fn().mockResolvedValue({}),
            remove: jest.fn().mockResolvedValue({ deleted: true }),
            addAssignee: jest.fn().mockResolvedValue({}),
        };
        const teamResources = { attach: jest.fn(), detach: jest.fn() };
        const links = {
            findByExternal: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
            removeAllFor: jest.fn().mockResolvedValue(1),
        };
        const idempotency = {
            run: jest.fn(
                async (
                    _input: unknown,
                    work: () => Promise<{ status: number; body: unknown }>,
                ) => ({
                    ...(await work()),
                    replayed: false,
                }),
            ),
        };
        const resources = {
            get: jest.fn(async (_kind: string, _org: string, id: string) => ({
                dto: { id, version: 3, teamIds: ['team-a', 'team-b'] },
                etag: '"3"',
            })),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationTasksWriteController(
            tasks as never,
            teamResources as never,
            links as never,
            idempotency as never,
            resources as never,
            scope as never,
        );
        return { controller, tasks, teamResources, links, idempotency, resources };
    };

    it('creates a backlog task attributed to the integration, linked to its externalRef', async () => {
        const { controller, tasks, links } = setup();
        const response = res();
        const body = await controller.create(
            user,
            {
                title: 'Ship it',
                teamIds: ['team-a', 'team-b'],
                assignees: [{ type: 'agent', id: 'agent-1' }],
                externalRef: { source: 'gauzy', externalId: 'g-1' },
            },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(tasks.create).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({
                title: 'Ship it',
                status: 'backlog',
                teamId: 'team-a',
                createdByType: 'integration',
                createdById: 'key-1',
            }),
            expect.anything(),
        );
        expect(links.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: ORG,
                source: 'gauzy',
                installationId: 'conn-1',
            }),
            expect.objectContaining({ entityType: 'task', entityId: 'task-1', externalId: 'g-1' }),
        );
        expect(tasks.addAssignee).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            'agent',
            'agent-1',
            expect.anything(),
        );
        expect(response.status).toHaveBeenCalledWith(201);
        expect(body).toMatchObject({ id: 'task-1' });
    });

    it('answers 200 with the existing task when the externalRef is already linked', async () => {
        const { controller, tasks, links } = setup();
        links.findByExternal.mockResolvedValue({ entityId: 'task-existing' });
        const response = res();
        const body = await controller.create(
            user,
            { title: 'Ship it', externalRef: { source: 'gauzy', externalId: 'g-1' } },
            'gauzy:conn-1',
            req(),
            response,
        );
        expect(tasks.create).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'task-existing' });
    });

    it('undoes its create when a concurrent request linked the externalRef first', async () => {
        const { controller, tasks, links } = setup();
        links.findByExternal
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ entityId: 'task-winner' });
        links.create.mockRejectedValue(
            new DuplicateExternalRefError('external', 'task-winner', 'g-1'),
        );
        const response = res();
        const body = await controller.create(
            user,
            { title: 'Ship it', externalRef: { source: 'gauzy', externalId: 'g-1' } },
            undefined,
            req(),
            response,
        );
        expect(tasks.remove).toHaveBeenCalledWith('owner-1', 'task-1', expect.anything());
        expect(response.status).toHaveBeenCalledWith(200);
        expect(body).toMatchObject({ id: 'task-winner' });
    });

    it('requires an Idempotency-Key, and refuses private visibility', async () => {
        const { controller } = setup();
        await expect(
            controller.create(user, { title: 'x' }, undefined, req(''), res()),
        ).rejects.toMatchObject({
            code: 'validation_failed',
        });
        await expect(
            controller.create(user, { title: 'x', visibility: 'private' }, undefined, req(), res()),
        ).rejects.toMatchObject({ code: 'domain_rule' });
    });

    it('PATCH honours If-Match and moves extra teams through team resources', async () => {
        const { controller, tasks, teamResources } = setup();
        await expect(
            controller.update(user, 'task-1', { title: 'New' }, '"2"', res()),
        ).rejects.toBeInstanceOf(VersionMismatchError);
        expect(tasks.update).not.toHaveBeenCalled();

        const response = res();
        await controller.update(
            user,
            'task-1',
            { title: 'New', teamIds: ['team-a', 'team-c'] },
            '"3"',
            response,
        );
        expect(tasks.update).toHaveBeenCalledWith(
            'owner-1',
            'task-1',
            { title: 'New', teamId: 'team-a' },
            expect.anything(),
        );
        expect(teamResources.attach).toHaveBeenCalledWith('owner-1', ORG, 'team-c', {
            resourceType: 'task',
            resourceId: 'task-1',
        });
        expect(teamResources.detach).toHaveBeenCalledWith(ORG, 'team-b', 'task', 'task-1');
        expect(response.setHeader).toHaveBeenCalledWith('ETag', '"3"');
        await expect(
            controller.update(user, 'task-1', {}, undefined, res()),
        ).rejects.toBeInstanceOf(IntegrationHttpException);
    });

    it('DELETE honours If-Match and drops the task links', async () => {
        const { controller, tasks, links } = setup();
        await expect(controller.remove(user, 'task-1', 'W/"9"')).rejects.toBeInstanceOf(
            VersionMismatchError,
        );
        await controller.remove(user, 'task-1', undefined);
        expect(tasks.remove).toHaveBeenCalledWith('owner-1', 'task-1', expect.anything());
        expect(links.removeAllFor).toHaveBeenCalledWith(ORG, 'task', 'task-1');
    });
});
