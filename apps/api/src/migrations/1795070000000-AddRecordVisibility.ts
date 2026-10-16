import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * One table that gains `visibility` / `visibilityExplicit`, and how a row of it
 * "sits on a Team" for the D11 backfill.
 */
interface VisibilityTable {
    table: string;
    /** `team_resources.resourceType` that points at this table. */
    resourceType: string;
    /** A direct team column on the row itself (tasks only). */
    teamColumn?: string;
    /** `team_members.memberType` that points at this table (agents only). */
    teamMemberType?: string;
}

/**
 * Record visibility (EW-P1-3, `docs/specs/features/record-visibility/spec.md`;
 * owner decisions D6 and D11 of the Ever Gauzy integration plan).
 *
 * Tasks, Goals, Missions, Ideas (`work_proposals`) and Agents stay owned by their
 * user exactly as before. Two columns ADD who else may read an org-scope row:
 *
 *   - `visibility varchar(16) NOT NULL DEFAULT 'private'` — `private` | `team` |
 *     `organization`;
 *   - `visibilityExplicit boolean NOT NULL DEFAULT false` — set once somebody picks a
 *     value by hand, which stops the automatic Team ↔ Organization changes.
 *
 * **Backfill (D11, applied to EXISTING rows automatically — no opt-in):** every
 * org-scope row (`organizationId IS NOT NULL`) becomes `team` when it sits on a Team
 * (`tasks.teamId`, a `team_resources` row of its type, or — for agents — a
 * `team_members` row) and `organization` otherwise. Personal-scope rows
 * (`organizationId IS NULL`) stay `private`. Only rows still at the column default
 * (`private`, not explicit) are touched, so a re-run, or a run after somebody chose
 * `private` by hand, changes nothing.
 *
 * **Roster backfill:** `organization_members` gets a row for every active user whose
 * `users.tenantId` matches the Organization's Tenant. Access in Ever Works is
 * tenant-wide (`OrganizationMembershipService` compares `user.tenantId` with
 * `organization.tenantId`), so these people can already open the Organization; the
 * roster only records it. The Tenant owner is skipped: they are a member by
 * construction, `listMembers` synthesizes their row, and seat counting already counts
 * them — a real row would change neither access nor anything else.
 *
 * Also: `idx_<table>_org_visibility (organizationId, visibility)` per table for the
 * org-wide reads of the access policy.
 *
 * `team_resources.resourceType` gains `goal` in code only: the column is a plain
 * `varchar(16)` with no CHECK constraint.
 *
 * Portable on Postgres, MySQL and better-sqlite3: `TableColumn` / `TableIndex` DDL,
 * identifiers quoted by the driver, and the dialect's boolean literal.
 *
 * `down()` drops the indexes and both columns. It leaves the backfilled roster rows:
 * they state true tenant membership, and they cannot be told apart from rows an
 * invitation acceptance wrote after this migration ran.
 */
export class AddRecordVisibility1795070000000 implements MigrationInterface {
    name = 'AddRecordVisibility1795070000000';

    static readonly TABLES: readonly VisibilityTable[] = [
        { table: 'tasks', resourceType: 'task', teamColumn: 'teamId' },
        { table: 'goals', resourceType: 'goal' },
        { table: 'missions', resourceType: 'mission' },
        { table: 'work_proposals', resourceType: 'idea' },
        { table: 'agents', resourceType: 'agent', teamMemberType: 'agent' },
    ];

    static readonly ROSTER_BATCH = 500;

    static indexName(table: string): string {
        return `idx_${table}_org_visibility`;
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const spec of AddRecordVisibility1795070000000.TABLES) {
            await this.addColumns(queryRunner, spec.table);
        }
        for (const spec of AddRecordVisibility1795070000000.TABLES) {
            await this.backfillVisibility(queryRunner, spec);
        }
        await this.backfillRoster(queryRunner);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const spec of [...AddRecordVisibility1795070000000.TABLES].reverse()) {
            const table = await queryRunner.getTable(spec.table);
            if (!table) continue;
            const indexName = AddRecordVisibility1795070000000.indexName(spec.table);
            if (table.indices.some((index) => index.name === indexName)) {
                await queryRunner.dropIndex(spec.table, indexName);
            }
            for (const column of ['visibilityExplicit', 'visibility']) {
                // Re-read each time: the sqlite driver rebuilds the table on
                // every column drop, so earlier metadata is stale.
                const current = await queryRunner.getTable(spec.table);
                if (current?.findColumnByName(column)) {
                    await queryRunner.dropColumn(spec.table, column);
                }
            }
        }
    }

    private async addColumns(queryRunner: QueryRunner, tableName: string): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        if (!table) return;

        if (!table.findColumnByName('visibility')) {
            await queryRunner.addColumn(
                tableName,
                new TableColumn({
                    name: 'visibility',
                    type: 'varchar',
                    length: '16',
                    isNullable: false,
                    default: "'private'",
                }),
            );
        }

        const afterVisibility = await queryRunner.getTable(tableName);
        if (afterVisibility && !afterVisibility.findColumnByName('visibilityExplicit')) {
            await queryRunner.addColumn(
                tableName,
                new TableColumn({
                    name: 'visibilityExplicit',
                    type: 'boolean',
                    isNullable: false,
                    default: false,
                }),
            );
        }

        const indexName = AddRecordVisibility1795070000000.indexName(tableName);
        const refreshed = await queryRunner.getTable(tableName);
        if (refreshed && !refreshed.indices.some((index) => index.name === indexName)) {
            await queryRunner.createIndex(
                tableName,
                new TableIndex({ name: indexName, columnNames: ['organizationId', 'visibility'] }),
            );
        }
    }

    /**
     * D11 for existing rows: org rows on a Team → `team`, the remaining org rows →
     * `organization`. Only rows still at the default (`private`, not explicit) move.
     */
    private async backfillVisibility(
        queryRunner: QueryRunner,
        spec: VisibilityTable,
    ): Promise<void> {
        const table = await queryRunner.getTable(spec.table);
        if (!table?.findColumnByName('visibility')) return;

        const q = (identifier: string): string => queryRunner.connection.driver.escape(identifier);
        const t = q(spec.table);
        const falseLiteral = this.booleanLiteral(queryRunner, false);
        const stillDefault =
            `${t}.${q('organizationId')} IS NOT NULL` +
            ` AND ${t}.${q('visibility')} = 'private'` +
            ` AND ${t}.${q('visibilityExplicit')} = ${falseLiteral}`;

        const onTeam: string[] = [];
        if (spec.teamColumn && table.findColumnByName(spec.teamColumn)) {
            onTeam.push(`${t}.${q(spec.teamColumn)} IS NOT NULL`);
        }
        if (await queryRunner.hasTable('team_resources')) {
            onTeam.push(
                `EXISTS (SELECT 1 FROM ${q('team_resources')} tr` +
                    ` WHERE tr.${q('resourceType')} = '${spec.resourceType}'` +
                    ` AND tr.${q('resourceId')} = ${t}.${q('id')})`,
            );
        }
        if (spec.teamMemberType && (await queryRunner.hasTable('team_members'))) {
            onTeam.push(
                `EXISTS (SELECT 1 FROM ${q('team_members')} tm` +
                    ` WHERE tm.${q('memberType')} = '${spec.teamMemberType}'` +
                    ` AND tm.${q('memberId')} = ${t}.${q('id')})`,
            );
        }

        if (onTeam.length > 0) {
            await queryRunner.query(
                `UPDATE ${t} SET ${q('visibility')} = 'team'` +
                    ` WHERE ${stillDefault} AND (${onTeam.join(' OR ')})`,
            );
        }
        await queryRunner.query(
            `UPDATE ${t} SET ${q('visibility')} = 'organization' WHERE ${stillDefault}`,
        );
    }

    /**
     * One `organization_members` row per (Organization, active tenant user) that has
     * none yet, in batches. Re-running finds no candidates, which is what makes the
     * backfill idempotent.
     */
    private async backfillRoster(queryRunner: QueryRunner): Promise<void> {
        for (const required of ['organization_members', 'organizations', 'users']) {
            if (!(await queryRunner.hasTable(required))) return;
        }
        const users = await queryRunner.getTable('users');
        const hasTenants = await queryRunner.hasTable('tenants');
        const q = (identifier: string): string => queryRunner.connection.driver.escape(identifier);
        const trueLiteral = this.booleanLiteral(queryRunner, true);
        const falseLiteral = this.booleanLiteral(queryRunner, false);
        const batch = AddRecordVisibility1795070000000.ROSTER_BATCH;

        for (;;) {
            const qb = queryRunner.manager
                .createQueryBuilder()
                .select(`o.${q('id')}`, 'organizationId')
                .addSelect(`o.${q('tenantId')}`, 'tenantId')
                .addSelect(`o.${q('createdAt')}`, 'organizationCreatedAt')
                .addSelect(`u.${q('id')}`, 'userId')
                .addSelect(`u.${q('createdAt')}`, 'userCreatedAt')
                .from('organizations', 'o')
                .innerJoin('users', 'u', `u.${q('tenantId')} = o.${q('tenantId')}`)
                .where(`u.${q('isActive')} = ${trueLiteral}`)
                .andWhere(
                    `NOT EXISTS (SELECT 1 FROM ${q('organization_members')} m` +
                        ` WHERE m.${q('organizationId')} = o.${q('id')}` +
                        ` AND m.${q('userId')} = u.${q('id')})`,
                );
            if (users?.findColumnByName('isAnonymous')) {
                qb.andWhere(`u.${q('isAnonymous')} = ${falseLiteral}`);
            }
            if (hasTenants) {
                qb.andWhere(
                    `NOT EXISTS (SELECT 1 FROM ${q('tenants')} tn` +
                        ` WHERE tn.${q('id')} = o.${q('tenantId')}` +
                        ` AND tn.${q('ownerUserId')} = u.${q('id')})`,
                );
            }
            const rows = await qb
                .orderBy(`o.${q('id')}`, 'ASC')
                .addOrderBy(`u.${q('id')}`, 'ASC')
                .limit(batch)
                .getRawMany<{
                    organizationId: string;
                    tenantId: string;
                    organizationCreatedAt: Date | string | null;
                    userId: string;
                    userCreatedAt: Date | string | null;
                }>();
            if (rows.length === 0) return;

            const now = new Date();
            const members = rows.map((row) => ({
                id: randomUUID(),
                organizationId: row.organizationId,
                tenantId: row.tenantId,
                userId: row.userId,
                role: 'member',
                invitedById: null,
                invitationId: null,
                joinedAt: this.earliestPossibleJoin(row.organizationCreatedAt, row.userCreatedAt, now),
                createdAt: now,
                updatedAt: now,
            }));
            await queryRunner.manager
                .createQueryBuilder()
                .insert()
                .into('organization_members', [
                    'id',
                    'organizationId',
                    'tenantId',
                    'userId',
                    'role',
                    'invitedById',
                    'invitationId',
                    'joinedAt',
                    'createdAt',
                    'updatedAt',
                ])
                .values(members)
                .execute();

            if (rows.length < batch) return;
        }
    }

    /**
     * Nobody records when a pre-roster member joined; the earliest moment they can
     * have been one is when both the Organization and their account existed.
     */
    private earliestPossibleJoin(
        organizationCreatedAt: Date | string | null,
        userCreatedAt: Date | string | null,
        fallback: Date,
    ): Date {
        const times = [organizationCreatedAt, userCreatedAt]
            .map((value) => (value ? new Date(value).getTime() : Number.NaN))
            .filter((time) => Number.isFinite(time));
        return times.length > 0 ? new Date(Math.max(...times)) : fallback;
    }

    /** `true`/`false` on Postgres; `1`/`0` on MySQL (tinyint) and SQLite (integer). */
    private booleanLiteral(queryRunner: QueryRunner, value: boolean): string {
        const type = queryRunner.connection.driver.options.type;
        if (type === 'postgres' || type === 'cockroachdb') {
            return value ? 'true' : 'false';
        }
        return value ? '1' : '0';
    }
}
