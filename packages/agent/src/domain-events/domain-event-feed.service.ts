import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { matchesAnyDomainEventPattern, type DomainEventEnvelope } from '@ever-works/contracts';
import { DataSource } from 'typeorm';
import { DomainEvent } from '../entities/domain-event.entity';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../entities/domain-event-relay-state.entity';
import { seqToBigInt, seqToString, toDomainEventEnvelope } from './domain-event-envelope';

/** What one feed page asks for (integration contract v1, B.2 `GET /events`). */
export interface DomainEventFeedQuery {
    /** The pinned organizations the caller may read. Empty → empty page. */
    readonly organizationIds: readonly string[];
    /** Return events with `seq` > `after` (`'0'` = from the start of retention). */
    readonly after: string;
    /** 1–1000, default 200. */
    readonly limit?: number;
    /** Catalog types / `<prefix>.*` / `*`; empty = everything except opt-in types. */
    readonly types?: readonly string[];
    /** Origin tags to leave out (the caller's own writes). */
    readonly excludeOrigins?: readonly string[];
}

export interface DomainEventFeedPage {
    readonly events: DomainEventEnvelope[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly head: string;
}

/** The cursor is older than the retention window: the consumer must resync (`410 cursor_expired`). */
export class DomainEventCursorExpiredError extends Error {
    constructor(
        readonly after: string,
        readonly floor: string,
    ) {
        super(`cursor ${after} is older than the retention floor ${floor}`);
        this.name = 'DomainEventCursorExpiredError';
    }
}

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;
/** Rows scanned per round while filling one page (filters can drop rows). */
const SCAN_CHUNK = 500;
/** Upper bound of rows scanned for one page, so a selective filter cannot scan the whole table. */
const MAX_SCAN = 5000;

/**
 * Reads the change feed (EW-P1-1 storage, served by EW-P1-4's
 * `GET /api/integrations/v1/events`).
 *
 * Rules (integration contract v1, B.2):
 *  - only dispatched rows (`seq` set), in ascending `seq`, of the given orgs;
 *  - never personal scope (`organizationId` null);
 *  - never events of aggregates that were `private` at event time, EXCEPT
 *    `*.visibility_changed` to private (id-only data);
 *  - `excludeOrigins` drops the caller's own writes (loop guard);
 *  - opt-in types (`task.runtime_updated`) only when named exactly;
 *  - `after` below the retention floor → {@link DomainEventCursorExpiredError}.
 *
 * `nextCursor` is the last SCANNED position, not the last returned one, so a
 * page that filtered rows out still moves the consumer forward.
 */
@Injectable()
export class DomainEventFeedService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async head(): Promise<string> {
        const state = await this.dataSource
            .getRepository(DomainEventRelayState)
            .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } });
        return seqToString(state?.lastSeq);
    }

    async readPage(query: DomainEventFeedQuery): Promise<DomainEventFeedPage> {
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const after = seqToBigInt(query.after || '0');
        const state = await this.dataSource
            .getRepository(DomainEventRelayState)
            .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } });
        const head = seqToBigInt(state?.lastSeq);
        const floor = seqToBigInt(state?.retentionFloorSeq);
        if (after < floor) {
            throw new DomainEventCursorExpiredError(after.toString(), floor.toString());
        }
        if (query.organizationIds.length === 0) {
            return { events: [], nextCursor: null, hasMore: false, head: head.toString() };
        }

        const types = query.types?.filter((type) => type.length > 0) ?? [];
        const excluded = new Set(query.excludeOrigins ?? []);
        const events: DomainEventEnvelope[] = [];
        let cursor = after;
        let scanned = 0;
        let exhausted = false;

        while (events.length < limit && scanned < MAX_SCAN) {
            const rows = await this.scan(query.organizationIds, cursor, SCAN_CHUNK);
            if (rows.length === 0) {
                exhausted = true;
                break;
            }
            for (const row of rows) {
                cursor = seqToBigInt(row.seq);
                scanned += 1;
                if (this.accepts(row, types, excluded)) {
                    events.push(toDomainEventEnvelope(row));
                    if (events.length >= limit) break;
                }
            }
            if (rows.length < SCAN_CHUNK && events.length < limit) {
                exhausted = true;
                break;
            }
        }

        const hasMore = !exhausted && cursor < head;
        const moved = cursor > after;
        return {
            events,
            nextCursor: moved ? cursor.toString() : null,
            hasMore,
            head: head.toString(),
        };
    }

    private accepts(
        row: DomainEvent,
        types: readonly string[],
        excluded: ReadonlySet<string>,
    ): boolean {
        if (row.originTag && excluded.has(row.originTag)) return false;
        const isPrivateNotice =
            row.type.endsWith('.visibility_changed') && row.visibility === 'private';
        if (row.visibility === 'private' && !isPrivateNotice) return false;
        if (types.length === 0) return matchesAnyDomainEventPattern(row.type, ['*']);
        return matchesAnyDomainEventPattern(row.type, types);
    }

    private scan(
        organizationIds: readonly string[],
        after: bigint,
        take: number,
    ): Promise<DomainEvent[]> {
        return this.dataSource
            .getRepository(DomainEvent)
            .createQueryBuilder('event')
            .where('event.seq IS NOT NULL')
            .andWhere('event.seq > :after', { after: after.toString() })
            .andWhere('event.organizationId IN (:...organizationIds)', {
                organizationIds: [...organizationIds],
            })
            .orderBy('event.seq', 'ASC')
            .take(take)
            .getMany();
    }
}
