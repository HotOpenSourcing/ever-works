import { getMetadataArgsStorage } from 'typeorm';
import { Agent } from '../agent.entity';
import { Goal } from '../goal.entity';
import { Mission } from '../mission.entity';
import { Task } from '../task.entity';
import { TEAM_RESOURCE_TYPES } from '../team-resource.entity';
import { WorkProposal } from '../work-proposal.entity';
import { applyInsertVisibilityDefault, hasVisibilityColumns } from '../_record-visibility';

/**
 * Record visibility columns + insert default (EW-P1-3,
 * `docs/specs/features/record-visibility/spec.md` §1 and §5).
 */
const ENTITIES = [
    ['Task', Task, 'tasks'],
    ['Goal', Goal, 'goals'],
    ['Mission', Mission, 'missions'],
    ['WorkProposal', WorkProposal, 'work_proposals'],
    ['Agent', Agent, 'agents'],
] as const;

type VisibilityInstance = {
    visibility?: string | null;
    visibilityExplicit?: boolean | null;
    organizationId?: string | null;
    teamId?: string | null;
    applyDefaultVisibility(): void;
};

function instanceOf(entityClass: (typeof ENTITIES)[number][1], fields: object): VisibilityInstance {
    return Object.assign(Object.create(entityClass.prototype), fields) as VisibilityInstance;
}

describe('record visibility columns (EW-P1-3)', () => {
    it.each(ENTITIES)(
        '%s declares visibility varchar(16) default private + visibilityExplicit boolean default false',
        (_name, entityClass) => {
            const columns = getMetadataArgsStorage().filterColumns(entityClass);
            const visibility = columns.find((column) => column.propertyName === 'visibility');
            const explicit = columns.find((column) => column.propertyName === 'visibilityExplicit');
            expect(visibility?.options).toEqual(
                expect.objectContaining({ type: 'varchar', length: 16, default: 'private' }),
            );
            expect(visibility?.options.nullable).toBeFalsy();
            expect(explicit?.options).toEqual(
                expect.objectContaining({ type: 'boolean', default: false }),
            );
            expect(explicit?.options.nullable).toBeFalsy();
        },
    );

    it.each(ENTITIES)('%s declares the org-visibility index', (_name, entityClass, table) => {
        const indices = getMetadataArgsStorage().indices.filter(
            (index) => index.target === entityClass,
        );
        expect(indices.map((index) => index.name)).toContain(`idx_${table}_org_visibility`);
    });

    it.each(ENTITIES)('%s registers the insert-time default listener', (_name, entityClass) => {
        const listeners = getMetadataArgsStorage().entityListeners.filter(
            (listener) => listener.target === entityClass && listener.type === 'before-insert',
        );
        expect(listeners.map((listener) => listener.propertyName)).toContain(
            'applyDefaultVisibility',
        );
    });

    it('team_resources accepts `goal` (goals sit on Teams like every other resource)', () => {
        expect(TEAM_RESOURCE_TYPES).toEqual(['work', 'task', 'agent', 'mission', 'idea', 'goal']);
    });
});

describe('insert-time visibility default (owner decision D11)', () => {
    it.each(ENTITIES)(
        '%s: an org row starts `organization`, not explicit',
        (_name, entityClass) => {
            const row = instanceOf(entityClass, { organizationId: 'org-1' });
            row.applyDefaultVisibility();
            expect(row.visibility).toBe('organization');
            expect(row.visibilityExplicit).toBe(false);
        },
    );

    it.each(ENTITIES)('%s: a personal row stays `private`', (_name, entityClass) => {
        const row = instanceOf(entityClass, { organizationId: null });
        row.applyDefaultVisibility();
        expect(row.visibility).toBe('private');
    });

    it.each(ENTITIES)(
        '%s: an unstamped row is left for the scope subscriber (then the column default)',
        (_name, entityClass) => {
            const row = instanceOf(entityClass, {});
            row.applyDefaultVisibility();
            expect(row.visibility).toBeUndefined();
        },
    );

    it('a Task created with a teamId starts `team`', () => {
        const row = instanceOf(Task, { organizationId: 'org-1', teamId: 'team-1' });
        row.applyDefaultVisibility();
        expect(row.visibility).toBe('team');
    });

    it('a visibility chosen by the caller is kept', () => {
        const row = instanceOf(Task, {
            organizationId: 'org-1',
            teamId: 'team-1',
            visibility: 'private',
            visibilityExplicit: true,
        });
        row.applyDefaultVisibility();
        expect(row.visibility).toBe('private');
        expect(row.visibilityExplicit).toBe(true);
    });

    it('applyInsertVisibilityDefault is idempotent', () => {
        const row: Parameters<typeof applyInsertVisibilityDefault>[0] = { organizationId: 'org-1' };
        applyInsertVisibilityDefault(row, false);
        applyInsertVisibilityDefault(row, true);
        expect(row).toEqual({
            organizationId: 'org-1',
            visibility: 'organization',
            visibilityExplicit: false,
        });
    });

    it('hasVisibilityColumns needs both columns', () => {
        expect(hasVisibilityColumns(['visibility', 'visibilityExplicit'])).toBe(true);
        expect(hasVisibilityColumns(['visibility'])).toBe(false);
        expect(hasVisibilityColumns(['id'])).toBe(false);
    });
});
