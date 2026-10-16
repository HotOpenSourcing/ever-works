import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DomainEventActor, DomainEventAggregateType } from '@ever-works/contracts';
import { DataSource, type EntityManager } from 'typeorm';
import { serializeOnSingleConnection } from '../database/repositories/single-connection-write-queue';
import { DomainEventRecorder } from './domain-event-recorder.service';
import {
    type AggregateSnapshot,
    buildAgentSnapshot,
    buildOrganizationSnapshot,
    buildTaskSnapshot,
    buildTeamSnapshot,
    buildWorkSnapshot,
} from './domain-event-snapshots';

/** Options every recording takes. */
export interface PublishOptions {
    readonly changedFields?: readonly string[];
    readonly previous?: Record<string, unknown>;
    /** Overrides the request context's actor (e.g. a cron's system actor). */
    readonly actor?: DomainEventActor;
}

type Builder = (manager: EntityManager, id: string) => Promise<AggregateSnapshot<object> | null>;

const BUILDERS: Partial<Record<DomainEventAggregateType, Builder>> = {
    task: buildTaskSnapshot,
    team: buildTeamSnapshot,
    agent: buildAgentSnapshot,
    work: buildWorkSnapshot,
    organization: buildOrganizationSnapshot,
};

/** A full snapshot taken BEFORE a hard delete, to record the tombstone after it. */
export interface AggregateTombstone {
    readonly aggregateType: DomainEventAggregateType;
    readonly id: string;
    readonly snapshot: AggregateSnapshot<object>;
}

/**
 * Records P1 domain events at the service-layer recording points (EW-P1-1 B2,
 * `docs/specs/features/domain-events/spec.md` §3–4).
 *
 * Every method takes the `EntityManager` of the transaction that makes the
 * change: the aggregate's `version` bump, its post-change snapshot and the
 * outbox row all commit (or roll back) with it. Services that are not
 * transactional today wrap their write and the recording in
 * {@link DomainEventPublisher.transaction}.
 *
 * Injected `@Optional()` everywhere, so a graph without it (unit tests, the
 * worker) keeps today's behaviour exactly.
 */
@Injectable()
export class DomainEventPublisher {
    constructor(
        readonly recorder: DomainEventRecorder,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    /**
     * Run `fn` in a transaction (the write and its event together). On
     * better-sqlite3, where a whole DataSource shares ONE connection and
     * overlapping transactions nest as savepoints, the transaction is queued
     * behind the platform's other serialized writes. Never call it from
     * inside another queued unit of work (it would wait on itself).
     */
    transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
        return serializeOnSingleConnection(this.dataSource.manager, () =>
            this.dataSource.transaction(fn),
        );
    }

    /**
     * A full-snapshot event (`<x>.created`, `<x>.updated`, `<x>.transitioned`,
     * `<x>.status_changed`, `<x>.archived`): bump the version, snapshot, record.
     * A row that no longer exists records nothing.
     */
    async changed(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        id: string,
        type: string,
        options: PublishOptions = {},
    ): Promise<void> {
        const builder = this.builderFor(aggregateType);
        const version = await this.recorder.bumpAggregateVersion(manager, aggregateType, id);
        const snapshot = await builder(manager, id);
        if (!snapshot) return;
        await this.recorder.record(manager, {
            type,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: aggregateType, id, version },
            data: snapshot.dto as Record<string, unknown>,
            changedFields: options.changedFields,
            previous: options.previous,
            actor: options.actor,
        });
    }

    /**
     * `<x>.created`: snapshot and record WITHOUT bumping — a new aggregate's
     * first event carries version 1. Call it after the row (and any edges
     * written in the same transaction) exist.
     */
    async created(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        id: string,
        type: string,
        options: PublishOptions = {},
    ): Promise<void> {
        const snapshot = await this.builderFor(aggregateType)(manager, id);
        if (!snapshot) return;
        await this.recorder.record(manager, {
            type,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: {
                type: aggregateType,
                id,
                version: Number((snapshot.dto as { version?: number }).version) || 1,
            },
            data: snapshot.dto as Record<string, unknown>,
            actor: options.actor,
        });
    }

    /**
     * A child event (`task.assignee.added`, `team.member.removed`, …): bump the
     * PARENT's version and record the child DTO with it.
     */
    async child(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        parentId: string,
        type: string,
        data: Record<string, unknown>,
        options: PublishOptions = {},
    ): Promise<void> {
        const builder = this.builderFor(aggregateType);
        const version = await this.recorder.bumpAggregateVersion(manager, aggregateType, parentId);
        const snapshot = await builder(manager, parentId);
        if (!snapshot) return;
        await this.recorder.record(manager, {
            type,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: aggregateType, id: parentId, version },
            data,
            changedFields: options.changedFields,
            previous: options.previous,
            actor: options.actor,
            visibility: (snapshot.dto as { visibility?: string }).visibility ?? null,
        });
    }

    /** Snapshot an aggregate before it is hard-deleted (call inside the delete's transaction). */
    async beforeDelete(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        id: string,
    ): Promise<AggregateTombstone | null> {
        const snapshot = await this.builderFor(aggregateType)(manager, id);
        return snapshot ? { aggregateType, id, snapshot } : null;
    }

    /** Record `<x>.deleted` with the last snapshot + `deleted: true`, version = last + 1. */
    async deleted(
        manager: EntityManager,
        tombstone: AggregateTombstone | null,
        type: string,
        options: PublishOptions = {},
    ): Promise<void> {
        if (!tombstone) return;
        const dto = tombstone.snapshot.dto as { version?: number };
        await this.recorder.record(manager, {
            type,
            tenantId: tombstone.snapshot.tenantId,
            organizationId: tombstone.snapshot.organizationId,
            aggregate: {
                type: tombstone.aggregateType,
                id: tombstone.id,
                version: (Number(dto.version) || 1) + 1,
            },
            data: { ...(tombstone.snapshot.dto as Record<string, unknown>), deleted: true },
            actor: options.actor,
        });
    }

    /**
     * `task.runtime_updated`: a machine-only write (PR/CI/run state). Bumps
     * neither `version` nor `updatedAt`; carries the current version.
     */
    async runtime(
        manager: EntityManager,
        taskId: string,
        options: PublishOptions = {},
    ): Promise<void> {
        const snapshot = await buildTaskSnapshot(manager, taskId);
        if (!snapshot) return;
        await this.recorder.record(manager, {
            type: 'task.runtime_updated',
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: 'task', id: taskId, version: snapshot.dto.version },
            data: snapshot.dto as unknown as Record<string, unknown>,
            changedFields: options.changedFields ?? ['runtime'],
            previous: options.previous,
            actor: options.actor ?? { type: 'system', id: 'runtime', label: null },
        });
    }

    private builderFor(aggregateType: DomainEventAggregateType): Builder {
        const builder = BUILDERS[aggregateType];
        if (!builder) throw new Error(`No snapshot builder for aggregate type "${aggregateType}"`);
        return builder;
    }
}
