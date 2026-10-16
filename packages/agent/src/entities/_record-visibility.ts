import { EventSubscriber, type EntitySubscriberInterface, type InsertEvent } from 'typeorm';
import { automaticRecordVisibility, type RecordVisibility } from '@ever-works/contracts';

/**
 * Record visibility (EW-P1-3, `docs/specs/features/record-visibility/spec.md`) — the
 * insert-time default shared by the five entities that carry it (tasks, goals,
 * missions, work_proposals, agents) and by the API's `ScopeStampingSubscriber`.
 *
 * A row's `visibility` only ADDS readers; ownership is unchanged. The default follows
 * owner decision D11: a personal-scope row is `private`, an org-scope row is `team` when
 * it is created on a Team and `organization` otherwise.
 */
export interface VisibilityRow {
    visibility?: RecordVisibility | null;
    visibilityExplicit?: boolean | null;
    organizationId?: string | null;
}

/**
 * Fill in `visibility` on a row about to be inserted, unless the caller chose one.
 *
 * - A visibility the caller already set is kept (a hand-picked value also sets
 *   `visibilityExplicit`, which the caller owns).
 * - `organizationId === undefined` means the scope has not been stamped yet: the
 *   {@link RecordVisibilitySubscriber} (registered with the DataSource, so it runs
 *   before the API's `ScopeStampingSubscriber`, which is pushed at module init) leaves
 *   the row alone, and `ScopeStampingSubscriber` calls this again once it has stamped
 *   the scope. If neither stamps a scope, the column default (`private`) applies,
 *   which is the right value for a personal row.
 *
 * Idempotent: calling it twice never changes a value it already set.
 */
export function applyInsertVisibilityDefault(row: VisibilityRow, hasTeam: boolean): void {
    if (row.visibility !== undefined && row.visibility !== null) {
        return;
    }
    if (row.organizationId === undefined) {
        return;
    }
    row.visibility = automaticRecordVisibility({
        organizationId: row.organizationId,
        hasTeam,
    });
    if (row.visibilityExplicit === undefined || row.visibilityExplicit === null) {
        row.visibilityExplicit = false;
    }
}

/** True for an entity class that carries the visibility columns (subscriber gate). */
export function hasVisibilityColumns(propertyNames: readonly string[]): boolean {
    return propertyNames.includes('visibility') && propertyNames.includes('visibilityExplicit');
}

/**
 * Applies {@link applyInsertVisibilityDefault} to every insert of an entity that carries
 * the visibility columns (tasks, goals, missions, work_proposals, agents). Registered
 * in the DataSource `subscribers` (`database.config.ts`), so it runs in every process
 * that writes — the API, the worker and the CLIs — for rows whose scope the caller set
 * explicitly. A subscriber rather than an entity `@BeforeInsert` method: a method on the
 * entity class would drop out of `{ ...task }` spreads and break the structural row
 * types built from them (`TaskWithRun`, `TaskSubtaskRow`).
 */
// `@EventSubscriber()` is required: TypeORM only instantiates the classes listed in the
// DataSource `subscribers` option that carry it.
@EventSubscriber()
export class RecordVisibilitySubscriber implements EntitySubscriberInterface {
    beforeInsert(event: InsertEvent<unknown>): void {
        const entity = event.entity as (VisibilityRow & { teamId?: string | null }) | undefined;
        if (!entity || !event.metadata) return;
        if (!hasVisibilityColumns(event.metadata.columns.map((column) => column.propertyName))) {
            return;
        }
        applyInsertVisibilityDefault(entity, Boolean(entity.teamId));
    }
}
