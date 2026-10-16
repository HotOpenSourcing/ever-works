import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In } from 'typeorm';
import {
    ExternalRecordLink,
    type ExternalLinkEntityType,
} from '../entities/external-record-link.entity';
import { isUniqueConstraintError } from '../utils/db-error.utils';
import { DuplicateExternalRefError } from './integration-api.errors';

/** Contract v1 `ExternalLink` (filtered to the caller's source). */
export interface ExternalLinkDto {
    readonly source: string;
    readonly installationId: string | null;
    readonly externalId: string;
    readonly externalUrl: string | null;
}

/** Contract v1 `link.schema.json` (`GET /links`, `PUT /links/...`). */
export interface ExternalRecordLinkDto extends ExternalLinkDto {
    readonly organizationId: string;
    readonly entityType: ExternalLinkEntityType;
    readonly entityId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/** Who is linking: the source (from the key's `integrationKind`) and its installation. */
export interface LinkScope {
    readonly organizationId: string;
    readonly tenantId?: string | null;
    readonly source: string;
    /** For Gauzy: the connection id. `null`/`undefined` = none. */
    readonly installationId?: string | null;
    readonly integrationKeyId?: string | null;
}

export interface LinkTarget {
    readonly entityType: ExternalLinkEntityType;
    readonly entityId: string;
    readonly externalId: string;
    readonly externalUrl?: string | null;
}

/**
 * `externalRef.installationId` when the caller sent one; otherwise the
 * installation named by `X-Sync-Origin: <source>:<installationId>` (contract
 * v1 `ExternalRef`), else none.
 */
export function installationFromOrigin(
    explicit: string | null | undefined,
    originTag: string | null | undefined,
    source: string,
): string | null {
    if (explicit) return explicit;
    if (!originTag) return null;
    const prefix = `${source}:`;
    return originTag.startsWith(prefix) && originTag.length > prefix.length
        ? originTag.slice(prefix.length)
        : null;
}

const toInstallationKey = (installationId: string | null | undefined): string =>
    installationId ? installationId : '';

export function toExternalLinkDto(row: ExternalRecordLink): ExternalLinkDto {
    return {
        source: row.source,
        installationId: row.installationKey ? row.installationKey : null,
        externalId: row.externalId,
        externalUrl: row.externalUrl ?? null,
    };
}

export function toExternalRecordLinkDto(row: ExternalRecordLink): ExternalRecordLinkDto {
    return {
        organizationId: row.organizationId,
        entityType: row.entityType,
        entityId: row.entityId,
        ...toExternalLinkDto(row),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

/**
 * External record links (EW-P1-4, contract v1 B.6 "Links" and `externalRef`).
 *
 * Every write takes an optional `EntityManager`, so a create and its link
 * commit together ("created atomically"): pass the manager of the
 * transaction that inserts the record. Uniqueness on both sides is the
 * database's (`uq_external_record_links_external` / `_entity`); a collision
 * surfaces as {@link DuplicateExternalRefError}.
 */
@Injectable()
export class ExternalRecordLinksService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    private repo(manager?: EntityManager) {
        return (manager ?? this.dataSource.manager).getRepository(ExternalRecordLink);
    }

    /** The Ever Works record an external record is linked to, if any (the `externalRef` replay check). */
    findByExternal(
        scope: LinkScope,
        entityType: ExternalLinkEntityType,
        externalId: string,
        manager?: EntityManager,
    ): Promise<ExternalRecordLink | null> {
        return this.repo(manager).findOne({
            where: {
                organizationId: scope.organizationId,
                source: scope.source,
                installationKey: toInstallationKey(scope.installationId),
                entityType,
                externalId,
            },
        });
    }

    /** `GET /links?entityType=&externalId=` — this source's links in the organization. */
    list(
        scope: Pick<LinkScope, 'organizationId' | 'source'>,
        filter: {
            entityType?: ExternalLinkEntityType;
            externalId?: string;
            entityId?: string;
        } = {},
    ): Promise<ExternalRecordLink[]> {
        return this.repo().find({
            where: {
                organizationId: scope.organizationId,
                source: scope.source,
                ...(filter.entityType ? { entityType: filter.entityType } : {}),
                ...(filter.externalId ? { externalId: filter.externalId } : {}),
                ...(filter.entityId ? { entityId: filter.entityId } : {}),
            },
            order: { createdAt: 'ASC' },
            take: 500,
        });
    }

    /**
     * `externalLinks[]` for a page of DTOs: every link of these records for
     * the caller's source (all installations), grouped by entity id.
     */
    async linksFor(
        entityType: ExternalLinkEntityType,
        entityIds: readonly string[],
        source: string,
        manager?: EntityManager,
    ): Promise<Map<string, ExternalLinkDto[]>> {
        const byEntity = new Map<string, ExternalLinkDto[]>();
        if (entityIds.length === 0) return byEntity;
        const rows = await this.repo(manager).find({
            where: { entityType, entityId: In([...new Set(entityIds)]), source },
            order: { createdAt: 'ASC' },
        });
        for (const row of rows) {
            const list = byEntity.get(row.entityId) ?? [];
            list.push(toExternalLinkDto(row));
            byEntity.set(row.entityId, list);
        }
        return byEntity;
    }

    /**
     * Create a link (the `externalRef` of a create, in its transaction).
     * Throws {@link DuplicateExternalRefError} when either side is already linked.
     */
    async create(
        scope: LinkScope,
        target: LinkTarget,
        manager?: EntityManager,
    ): Promise<ExternalRecordLink> {
        const repo = this.repo(manager);
        try {
            return await repo.save(
                repo.create({
                    tenantId: scope.tenantId ?? null,
                    organizationId: scope.organizationId,
                    source: scope.source,
                    installationKey: toInstallationKey(scope.installationId),
                    entityType: target.entityType,
                    entityId: target.entityId,
                    externalId: target.externalId,
                    externalUrl: target.externalUrl ?? null,
                    integrationKeyId: scope.integrationKeyId ?? null,
                }),
            );
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                throw await this.duplicateOf(scope, target, manager);
            }
            throw error;
        }
    }

    /**
     * `PUT /links/:entityType/:entityId {externalId, externalUrl}` — set the
     * record's link for this source and installation (create or move it).
     * Throws {@link DuplicateExternalRefError} when the external record is
     * already linked to another Ever Works record.
     */
    async put(
        scope: LinkScope,
        target: LinkTarget,
        manager?: EntityManager,
    ): Promise<ExternalRecordLink> {
        const repo = this.repo(manager);
        const installationKey = toInstallationKey(scope.installationId);
        const existing = await repo.findOne({
            where: {
                organizationId: scope.organizationId,
                source: scope.source,
                installationKey,
                entityType: target.entityType,
                entityId: target.entityId,
            },
        });
        if (!existing) return this.create(scope, target, manager);
        if (
            existing.externalId === target.externalId &&
            (existing.externalUrl ?? null) === (target.externalUrl ?? null)
        ) {
            return existing;
        }
        existing.externalId = target.externalId;
        existing.externalUrl = target.externalUrl ?? null;
        existing.integrationKeyId = scope.integrationKeyId ?? existing.integrationKeyId ?? null;
        try {
            return await repo.save(existing);
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                throw await this.duplicateOf(scope, target, manager);
            }
            throw error;
        }
    }

    /** `DELETE /links/:entityType/:entityId` — remove this source's link (any installation unless named). */
    async remove(
        scope: Pick<LinkScope, 'organizationId' | 'source' | 'installationId'>,
        entityType: ExternalLinkEntityType,
        entityId: string,
        manager?: EntityManager,
    ): Promise<number> {
        const result = await this.repo(manager).delete({
            organizationId: scope.organizationId,
            source: scope.source,
            ...(scope.installationId !== undefined
                ? { installationKey: toInstallationKey(scope.installationId) }
                : {}),
            entityType,
            entityId,
        });
        return result.affected ?? 0;
    }

    /** Drop every link of a deleted record (any source), in the delete's transaction. */
    async removeAllFor(
        entityType: ExternalLinkEntityType,
        entityId: string,
        manager?: EntityManager,
    ): Promise<number> {
        const result = await this.repo(manager).delete({ entityType, entityId });
        return result.affected ?? 0;
    }

    private async duplicateOf(
        scope: LinkScope,
        target: LinkTarget,
        manager?: EntityManager,
    ): Promise<DuplicateExternalRefError> {
        const repo = this.repo(manager);
        const installationKey = toInstallationKey(scope.installationId);
        const byExternal = await repo.findOne({
            where: {
                organizationId: scope.organizationId,
                source: scope.source,
                installationKey,
                entityType: target.entityType,
                externalId: target.externalId,
            },
        });
        if (byExternal) {
            return new DuplicateExternalRefError(
                'external',
                byExternal.entityId,
                byExternal.externalId,
            );
        }
        const byEntity = await repo.findOne({
            where: {
                organizationId: scope.organizationId,
                source: scope.source,
                installationKey,
                entityType: target.entityType,
                entityId: target.entityId,
            },
        });
        return new DuplicateExternalRefError(
            'entity',
            target.entityId,
            byEntity?.externalId ?? target.externalId,
        );
    }
}
