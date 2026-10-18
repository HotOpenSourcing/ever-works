import type { FleetNodeView, NeedsALookItem } from '@ever-works/contracts';

/**
 * Fleet "needs a look" (CONTRACTS §4.6, R-23) — the producer seam.
 *
 * Seam owned by FL-01 (hub & navigation), built by FL-03 at the path and with
 * the names of FL-01's plan (T-05) because FL-03's producers landed first.
 * FL-01 extends this file and `needs-a-look.service.ts`; it does not write a
 * second registry.
 *
 * A producer is handed the computers the viewer may see, ONCE per request,
 * and returns the items its facts call for. It must be pure over what it is
 * given (no per-node queries — the hub reads one row per computer) and it
 * may throw: the service logs it with the producer's id and renders the
 * other producers' items (spec U14).
 */
export interface NeedsALookContext {
    /** "Now" for every producer of one request, so they agree on time. */
    now: Date;
}

export interface NeedsALookProducer {
    /** Stable id — named in the log when the producer throws. */
    readonly id: string;
    produce(
        nodes: readonly FleetNodeView[],
        context: NeedsALookContext,
    ): Promise<NeedsALookItem[]> | NeedsALookItem[];
}

/**
 * DI token for the producer list: `{ provide: NEEDS_A_LOOK_PRODUCERS,
 * useFactory: (...producers) => producers, inject: [...] }`. A module that
 * cannot extend that list registers at init with `NeedsALookService.register`.
 */
export const NEEDS_A_LOOK_PRODUCERS = Symbol('NEEDS_A_LOOK_PRODUCERS');
