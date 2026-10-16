import { Brackets, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import { InvalidCursorError } from './integration-api.errors';

/**
 * Keyset paging for integration lists (EW-P1-4, contract v1 B.1):
 * `?updatedSince=<ISO>&cursor=<opaque>&limit=<≤500, default 200>`, ordered by
 * `(updatedAt, id)`, answering `{ data, nextCursor, hasMore }`.
 *
 * The cursor is the `(updatedAt, id)` of the last row returned, base64url
 * JSON with a version tag: opaque to clients, stable across deploys, and
 * strictly increasing — a row updated after the page was read moves BEHIND
 * the cursor and is picked up by the next `updatedSince` sync, never lost.
 */
export const KEYSET_DEFAULT_LIMIT = 200;
export const KEYSET_MAX_LIMIT = 500;

export interface KeysetPosition {
    readonly updatedAt: Date;
    readonly id: string;
}

export interface KeysetQuery {
    readonly updatedSince?: Date | null;
    readonly cursor?: string | null;
    readonly limit?: number | null;
}

export interface KeysetPage<T> {
    readonly data: T[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
}

const VERSION = 1;

export function encodeKeysetCursor(position: KeysetPosition): string {
    return Buffer.from(
        JSON.stringify({ v: VERSION, u: position.updatedAt.getTime(), i: position.id }),
        'utf8',
    ).toString('base64url');
}

/** Throws {@link InvalidCursorError} for anything this API did not issue. */
export function decodeKeysetCursor(cursor: string): KeysetPosition {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
            v?: unknown;
            u?: unknown;
            i?: unknown;
        };
        if (
            parsed.v !== VERSION ||
            typeof parsed.u !== 'number' ||
            !Number.isFinite(parsed.u) ||
            typeof parsed.i !== 'string' ||
            parsed.i.length === 0 ||
            parsed.i.length > 64
        ) {
            throw new InvalidCursorError();
        }
        return { updatedAt: new Date(parsed.u), id: parsed.i };
    } catch {
        throw new InvalidCursorError();
    }
}

/** 1–500; a missing or non-finite limit is the default. */
export function keysetLimit(limit: number | null | undefined): number {
    const requested =
        typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : KEYSET_DEFAULT_LIMIT;
    return Math.min(Math.max(requested, 1), KEYSET_MAX_LIMIT);
}

/**
 * Read one keyset page from `qb` (already filtered to what the caller may
 * see). `alias` is the query's main alias; the entity must have `updatedAt`
 * and `id`. Reads `limit + 1` rows to know whether there is more.
 */
export async function readKeysetPage<T extends ObjectLiteral & { updatedAt: Date; id: string }>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    query: KeysetQuery,
): Promise<KeysetPage<T>> {
    const limit = keysetLimit(query.limit);
    if (query.updatedSince) {
        qb.andWhere(`${alias}.updatedAt >= :keysetUpdatedSince`, {
            keysetUpdatedSince: query.updatedSince,
        });
    }
    if (query.cursor) {
        const after = decodeKeysetCursor(query.cursor);
        qb.andWhere(
            new Brackets((where) => {
                where
                    .where(`${alias}.updatedAt > :keysetAfterUpdatedAt`, {
                        keysetAfterUpdatedAt: after.updatedAt,
                    })
                    .orWhere(
                        new Brackets((tie) => {
                            tie.where(`${alias}.updatedAt = :keysetAfterUpdatedAt`, {
                                keysetAfterUpdatedAt: after.updatedAt,
                            }).andWhere(`${alias}.id > :keysetAfterId`, { keysetAfterId: after.id });
                        }),
                    );
            }),
        );
    }
    const rows = await qb
        .orderBy(`${alias}.updatedAt`, 'ASC')
        .addOrderBy(`${alias}.id`, 'ASC')
        .take(limit + 1)
        .getMany();
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = data[data.length - 1];
    return {
        data,
        nextCursor: hasMore && last ? encodeKeysetCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
        hasMore,
    };
}
