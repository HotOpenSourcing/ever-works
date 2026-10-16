jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { IntegrationKeyService } from './integration-key.service';

/**
 * EW-P2-6 — Organization admins and integration keys: who may create one, which
 * Organizations they may pin, which pins a key may use at request time, and the
 * `org:write` auto-pin — over doubles of the repositories.
 */
describe('integration keys and organization admins (EW-P2-6)', () => {
    const TENANT = 'tenant-1';
    const OWNER = 'owner-1';
    const ADMIN = 'admin-1';
    const MEMBER = 'member-1';
    const ORG_A = 'org-a';
    const ORG_B = 'org-b';

    const tenants = {
        findById: jest.fn(async (id: string) =>
            id === TENANT ? { id, ownerUserId: OWNER } : null,
        ),
    };
    const members = {
        listAdministeredOrganizationIds: jest.fn(async (userId: string) =>
            userId === ADMIN ? [ORG_A] : [],
        ),
    };

    describe('ApiKeyService.effectivePins', () => {
        const service = new ApiKeyService({} as never, tenants as never, members as never);

        it('keeps every pin of a key the Tenant owner created', async () => {
            await expect(
                service.effectivePins({
                    userId: OWNER,
                    tenantId: TENANT,
                    organizationIds: [ORG_A, ORG_B],
                }),
            ).resolves.toEqual([ORG_A, ORG_B]);
        });

        it("narrows an admin's key to what the admin still administers", async () => {
            await expect(
                service.effectivePins({
                    userId: ADMIN,
                    tenantId: TENANT,
                    organizationIds: [ORG_A, ORG_B],
                }),
            ).resolves.toEqual([ORG_A]);
            // Demoted: no pins left.
            await expect(
                service.effectivePins({
                    userId: MEMBER,
                    tenantId: TENANT,
                    organizationIds: [ORG_A],
                }),
            ).resolves.toEqual([]);
        });

        it('fails closed on a lookup error, and keeps the stored pins without the repositories', async () => {
            const broken = new ApiKeyService(
                {} as never,
                tenants as never,
                {
                    listAdministeredOrganizationIds: jest
                        .fn()
                        .mockRejectedValue(new Error('db down')),
                } as never,
            );
            await expect(
                broken.effectivePins({ userId: ADMIN, tenantId: TENANT, organizationIds: [ORG_A] }),
            ).resolves.toEqual([]);
            const legacy = new ApiKeyService({} as never);
            await expect(
                legacy.effectivePins({ userId: ADMIN, tenantId: TENANT, organizationIds: [ORG_A] }),
            ).resolves.toEqual([ORG_A]);
        });
    });

    describe('IntegrationKeyService', () => {
        const setup = () => {
            const apiKeys = {
                countActiveIntegrationKeysByTenant: jest.fn().mockResolvedValue(0),
                create: jest.fn(async (row: Record<string, unknown>) => ({
                    ...row,
                    id: 'key-1',
                    createdAt: new Date(),
                })),
                findIntegrationKeysByTenant: jest.fn().mockResolvedValue([
                    { id: 'k-owner', userId: OWNER, organizationIds: [ORG_A] },
                    { id: 'k-admin', userId: ADMIN, organizationIds: [ORG_A] },
                ]),
                findById: jest.fn(async (id: string) =>
                    id === 'key-1' ? { id, kind: 'integration', organizationIds: [ORG_A] } : null,
                ),
                updateOrganizationIds: jest.fn().mockResolvedValue(true),
            };
            const organizations = {
                findByTenantId: jest.fn().mockResolvedValue([
                    { id: ORG_A, slug: 'a', displayName: 'A' },
                    { id: ORG_B, slug: 'b', displayName: 'B' },
                ]),
            };
            const users = {
                findById: jest.fn(async (id: string) => ({ id, tenantId: TENANT })),
            };
            const service = new IntegrationKeyService(
                apiKeys as never,
                tenants as never,
                organizations as never,
                users as never,
                undefined,
                undefined,
                members as never,
            );
            return { service, apiKeys };
        };
        const input = (organizationIds: string[]) =>
            ({
                name: 'Gauzy',
                integrationKind: 'ever-gauzy',
                scopes: ['tasks:read'],
                organizationIds,
            }) as never;

        it('an admin creates a key pinned to the Organizations they administer', async () => {
            const { service, apiKeys } = setup();
            await service.create(ADMIN, input([ORG_A]));
            expect(apiKeys.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: ADMIN,
                    tenantId: TENANT,
                    organizationIds: [ORG_A],
                }),
            );
        });

        it('an admin cannot pin an Organization they do not administer; a member cannot create', async () => {
            const { service } = setup();
            await expect(service.create(ADMIN, input([ORG_B]))).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(service.create(MEMBER, input([ORG_A]))).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('the owner lists every key of the Tenant; an admin lists their own', async () => {
            const { service } = setup();
            expect((await service.list(OWNER)).map((key) => key.id)).toEqual([
                'k-owner',
                'k-admin',
            ]);
            expect((await service.list(ADMIN)).map((key) => key.id)).toEqual(['k-admin']);
            expect(await service.list(MEMBER)).toEqual([]);
        });

        it('addPin appends a pin once and refuses a key that is not an integration key', async () => {
            const { service, apiKeys } = setup();
            await expect(service.addPin('key-1', ORG_B)).resolves.toEqual([ORG_A, ORG_B]);
            expect(apiKeys.updateOrganizationIds).toHaveBeenCalledWith('key-1', [ORG_A, ORG_B]);
            await expect(service.addPin('key-1', ORG_A)).resolves.toEqual([ORG_A]);
            await expect(service.addPin('nope', ORG_A)).rejects.toThrow('not found');
        });
    });
});
