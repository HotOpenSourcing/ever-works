import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type ObjectLiteral } from 'typeorm';
import {
    buildAgentSnapshot,
    buildMemberSnapshot,
    buildOrganizationSnapshot,
    buildTaskSnapshot,
    buildTeamSnapshot,
    buildWorkSnapshot,
    type AggregateSnapshot,
} from '../domain-events/domain-event-snapshots';
import { Agent } from '../entities/agent.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { Task } from '../entities/task.entity';
import { Team } from '../entities/team.entity';
import { Work } from '../entities/work.entity';
import { ExternalRecordLinksService, type ExternalLinkDto } from './external-record-links.service';
import { etagFor } from './if-match';
import { ResourceNotFoundError } from './integration-api.errors';
import { type KeysetPage, type KeysetQuery, readKeysetPage } from './keyset-cursor';

/** The versioned P1 resources the integration API reads (contract v1 B.6). */
export type IntegrationResourceKind = 'task' | 'team' | 'agent' | 'work';

type Row = ObjectLiteral & { id: string; updatedAt: Date; organizationId?: string | null };
type Builder = (manager: EntityManager, id: string) => Promise<AggregateSnapshot<object> | null>;

const RESOURCES: Readonly<
    Record<IntegrationResourceKind, { entity: new () => Row; build: Builder; archivable: boolean }>
> = {
    task: { entity: Task as unknown as new () => Row, build: buildTaskSnapshot, archivable: false },
    team: { entity: Team as unknown as new () => Row, build: buildTeamSnapshot, archivable: false },
    agent: {
        entity: Agent as unknown as new () => Row,
        build: buildAgentSnapshot,
        archivable: true,
    },
    work: { entity: Work as unknown as new () => Row, build: buildWorkSnapshot, archivable: true },
};

/** A list query: keyset paging plus `includeArchived` (agents and works; default false). */
export interface IntegrationListQuery extends KeysetQuery {
    readonly includeArchived?: boolean;
}

/** A resource DTO with the caller's `externalLinks`, plus its `ETag`. */
export interface IntegrationResource {
    readonly dto: Record<string, unknown>;
    readonly etag: string | null;
}

/**
 * Reads of `/api/integrations/v1` resources (EW-P1-4, contract v1 B.6).
 *
 * The DTOs are exactly the domain-event `data` snapshots (the same builders),
 * so a resource read and an event of the same version are byte-equivalent,
 * plus `externalLinks` filtered to the caller's source.
 *
 * Visibility (contract v1 §1.3): the integration principal sees `team` and
 * `organization` rows of its pinned organization; a `private` row is never
 * served — it is left out of lists and answers `404 not_found` by id.
 */
@Injectable()
export class IntegrationResourcesService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly links: ExternalRecordLinksService,
    ) {}

    async list(
        kind: IntegrationResourceKind,
        organizationId: string,
        query: IntegrationListQuery,
        source: string,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        const { entity, build, archivable } = RESOURCES[kind];
        const qb = this.dataSource
            .getRepository(entity)
            .createQueryBuilder('row')
            .where('row.organizationId = :organizationId', { organizationId });
        if (archivable && !query.includeArchived) {
            qb.andWhere('row.status != :archived', { archived: 'archived' });
        }
        const page = await readKeysetPage(qb, 'row', query);
        const manager = this.dataSource.manager;
        const dtos: Record<string, unknown>[] = [];
        for (const row of page.data) {
            const snapshot = await build(manager, row.id);
            if (!snapshot || isPrivate(snapshot.dto)) continue;
            dtos.push(snapshot.dto as Record<string, unknown>);
        }
        return {
            data: await this.withLinks(kind, organizationId, dtos, source),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        };
    }

    async get(
        kind: IntegrationResourceKind,
        organizationId: string,
        id: string,
        source: string,
    ): Promise<IntegrationResource> {
        const snapshot = await RESOURCES[kind].build(this.dataSource.manager, id);
        if (!snapshot || snapshot.organizationId !== organizationId || isPrivate(snapshot.dto)) {
            throw notFound(kind, id);
        }
        const [dto] = await this.withLinks(
            kind,
            organizationId,
            [snapshot.dto as Record<string, unknown>],
            source,
        );
        const version = Number((snapshot.dto as { version?: unknown }).version);
        return { dto, etag: Number.isFinite(version) ? etagFor(version) : null };
    }

    /** `GET /organization` — the pinned organization. */
    async organization(organizationId: string): Promise<IntegrationResource> {
        const snapshot = await buildOrganizationSnapshot(this.dataSource.manager, organizationId);
        if (!snapshot) throw notFound('organization', organizationId);
        const version = Number((snapshot.dto as { version?: unknown }).version);
        return {
            dto: snapshot.dto as unknown as Record<string, unknown>,
            etag: Number.isFinite(version) ? etagFor(version) : null,
        };
    }

    /** `GET /members` — the organization's roster, ordered by `(updatedAt, id)`. */
    async members(
        organizationId: string,
        query: KeysetQuery,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        const qb = this.dataSource
            .getRepository(OrganizationMember)
            .createQueryBuilder('row')
            .where('row.organizationId = :organizationId', { organizationId });
        const page = await readKeysetPage(qb, 'row', query);
        const data: Record<string, unknown>[] = [];
        for (const row of page.data) {
            const member = await buildMemberSnapshot(this.dataSource.manager, row);
            if (member) data.push(member as unknown as Record<string, unknown>);
        }
        return { data, nextCursor: page.nextCursor, hasMore: page.hasMore };
    }

    private async withLinks(
        kind: IntegrationResourceKind,
        organizationId: string,
        dtos: Record<string, unknown>[],
        source: string,
    ): Promise<Record<string, unknown>[]> {
        const ids = dtos.map((dto) => String(dto.id));
        const byEntity = await this.links.linksFor(organizationId, kind, ids, source);
        return dtos.map((dto) => ({
            ...dto,
            externalLinks: byEntity.get(String(dto.id)) ?? ([] as ExternalLinkDto[]),
        }));
    }
}

function isPrivate(dto: object): boolean {
    return (dto as { visibility?: unknown }).visibility === 'private';
}

function notFound(kind: string, id: string): ResourceNotFoundError {
    return new ResourceNotFoundError(kind, id);
}
