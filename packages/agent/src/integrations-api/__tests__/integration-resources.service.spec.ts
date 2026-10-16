import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { DataSource } from 'typeorm';
import {
    CONTRACT_DIR,
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
    TENANT,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMember } from '../../entities/organization-member.entity';
import { Task } from '../../entities/task.entity';
import { Team } from '../../entities/team.entity';
import { User } from '../../entities/user.entity';
import { ExternalRecordLinksService } from '../external-record-links.service';
import { ResourceNotFoundError } from '../integration-api.errors';
import { IntegrationResourcesService } from '../integration-resources.service';

/**
 * Integration API v1 reads (EW-P1-4) on SQLite: org-scoped keyset lists and
 * gets built from the domain-event snapshots, `externalLinks` for the caller's
 * source, `ETag`, and every DTO valid against the published contract schema.
 */
const BASE = 'https://ever.works/schemas/integrations/v1/';

function contract() {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) return walk(path);
            return name.endsWith('.schema.json') ? [path] : [];
        });
    for (const file of walk(join(CONTRACT_DIR, 'schemas'))) {
        ajv.addSchema(JSON.parse(readFileSync(file, 'utf8')));
    }
    return (ref: string, value: unknown) => {
        const validate = ajv.getSchema(BASE + ref)!;
        if (!validate(JSON.parse(JSON.stringify(value)))) {
            throw new Error(`${ref}: ${JSON.stringify(validate.errors, null, 1)}`);
        }
    };
}

describe('IntegrationResourcesService', () => {
    let dataSource: DataSource;
    let links: ExternalRecordLinksService;
    let resources: IntegrationResourcesService;
    const expectValid = contract();
    const OWNER = randomUUID();

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        links = new ExternalRecordLinksService(dataSource);
        resources = new IntegrationResourcesService(dataSource, links);
    });

    beforeEach(async () => {
        for (const table of [
            'tasks',
            'teams',
            'agents',
            'organizations',
            'organization_members',
            'users',
            'external_record_links',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        await dataSource.getRepository(Organization).insert([
            {
                id: ORG_A,
                tenantId: TENANT,
                slug: `a-${randomUUID().slice(0, 6)}`,
                displayName: 'Acme',
            },
            {
                id: ORG_B,
                tenantId: TENANT,
                slug: `b-${randomUUID().slice(0, 6)}`,
                displayName: 'Beta',
            },
        ] as unknown as Organization[]);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const task = (organizationId: string, title: string) =>
        dataSource.getRepository(Task).save({
            id: randomUUID(),
            userId: OWNER,
            slug: `T-${Math.floor(Math.random() * 1e6)}`,
            title,
            createdByType: 'user',
            createdById: OWNER,
            tenantId: TENANT,
            organizationId,
        } as unknown as Task);

    it('lists only the pinned organization tasks, as contract task DTOs with externalLinks', async () => {
        const mine = await task(ORG_A, 'Ship the feed');
        await task(ORG_B, 'Not yours');
        await links.create(
            { organizationId: ORG_A, source: 'gauzy', installationId: 'conn-1' },
            { entityType: 'task', entityId: mine.id, externalId: 'g-1' },
        );
        const page = await resources.list('task', ORG_A, { limit: 50 }, 'gauzy');
        expect(page.data.map((dto) => dto.id)).toEqual([mine.id]);
        expect(page).toMatchObject({ hasMore: false, nextCursor: null });
        expect(page.data[0].externalLinks).toEqual([
            { source: 'gauzy', installationId: 'conn-1', externalId: 'g-1', externalUrl: null },
        ]);
        expectValid('resources/task.schema.json', page.data[0]);
        // Another source sees no links.
        const jira = await resources.list('task', ORG_A, {}, 'jira');
        expect(jira.data[0].externalLinks).toEqual([]);
    });

    it('pages with a cursor and filters by updatedSince', async () => {
        const created = [];
        for (let i = 0; i < 3; i++) created.push(await task(ORG_A, `Task ${i}`));
        const first = await resources.list('task', ORG_A, { limit: 2 }, 'gauzy');
        expect(first.data).toHaveLength(2);
        expect(first.hasMore).toBe(true);
        const second = await resources.list(
            'task',
            ORG_A,
            { limit: 2, cursor: first.nextCursor },
            'gauzy',
        );
        expect([...first.data, ...second.data].map((dto) => dto.id).sort()).toEqual(
            created.map((row) => row.id).sort(),
        );
        const later = await resources.list(
            'task',
            ORG_A,
            { updatedSince: new Date(Date.now() + 60_000) },
            'gauzy',
        );
        expect(later.data).toEqual([]);
    });

    it('gets one resource with its ETag, and 404s outside the organization', async () => {
        const mine = await task(ORG_A, 'Ship the feed');
        const other = await task(ORG_B, 'Not yours');
        const got = await resources.get('task', ORG_A, mine.id, 'gauzy');
        expect(got.etag).toBe('"1"');
        expect(got.dto).toMatchObject({ id: mine.id, title: 'Ship the feed', externalLinks: [] });
        await expect(resources.get('task', ORG_A, other.id, 'gauzy')).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
        await expect(resources.get('task', ORG_A, randomUUID(), 'gauzy')).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
    });

    it('serves teams and agents of the organization as contract DTOs', async () => {
        const team = await dataSource.getRepository(Team).save({
            userId: OWNER,
            name: 'Platform',
            slug: 'platform',
            tenantId: TENANT,
            organizationId: ORG_A,
        } as unknown as Team);
        const agent = await dataSource.getRepository(Agent).save({
            userId: OWNER,
            scope: 'tenant',
            name: 'Builder',
            slug: 'builder',
            permissions: {},
            tenantId: TENANT,
            organizationId: ORG_A,
        } as unknown as Agent);
        const teams = await resources.list('team', ORG_A, {}, 'gauzy');
        expect(teams.data.map((dto) => dto.id)).toEqual([team.id]);
        expectValid('resources/team.schema.json', teams.data[0]);
        const agentDto = await resources.get('agent', ORG_A, agent.id, 'gauzy');
        expectValid('resources/agent.schema.json', agentDto.dto);
    });

    it('serves the organization and its members', async () => {
        const org = await resources.organization(ORG_A);
        expect(org.dto).toMatchObject({ id: ORG_A, displayName: 'Acme' });
        expect(org.etag).toBe('"1"');
        expectValid('resources/organization.schema.json', org.dto);

        const userId = randomUUID();
        await dataSource.getRepository(User).insert({
            id: userId,
            username: 'ruslan',
            slug: `ruslan-${userId.slice(0, 6)}`,
            email: 'ruslan@example.com',
            tenantId: TENANT,
            isActive: true,
        } as unknown as User);
        await dataSource.getRepository(OrganizationMember).insert({
            organizationId: ORG_A,
            userId,
            tenantId: TENANT,
            role: 'member',
            joinedAt: new Date(),
        } as unknown as OrganizationMember);
        const members = await resources.members(ORG_A, {});
        expect(members.data).toHaveLength(1);
        expect(members.data[0]).toMatchObject({
            organizationId: ORG_A,
            userId,
            username: 'ruslan',
        });
        expectValid('resources/member.schema.json', members.data[0]);
    });
});
