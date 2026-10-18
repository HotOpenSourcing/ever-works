import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sortNeedsALook, type FleetNodeView, type NeedsALookItem } from '@ever-works/contracts';
import {
    NEEDS_A_LOOK_PRODUCERS,
    type NeedsALookContext,
    type NeedsALookProducer,
} from './needs-a-look.producer';

export interface NeedsALookResult {
    /** Every producer's items, deduped by id and in the one sort order (CONTRACTS §4.6). */
    items: NeedsALookItem[];
    /** True when at least one producer threw; its items are missing, the others' are here. */
    partial: boolean;
}

/**
 * Fleet "needs a look" — fans the visible computers out to every registered
 * producer and merges what they say. Seam owned by FL-01; see
 * `needs-a-look.producer.ts`.
 *
 * One producer failing never hides another's items (spec U14): its failure
 * is logged with its id and the answer is marked `partial`. Items are deduped
 * on their stable id (the first producer to claim an id wins) and sorted with
 * {@link sortNeedsALook}, so every surface shows the same list in the same
 * order.
 */
@Injectable()
export class NeedsALookService {
    private readonly logger = new Logger(NeedsALookService.name);
    private readonly producers: NeedsALookProducer[];

    constructor(@Optional() @Inject(NEEDS_A_LOOK_PRODUCERS) producers?: NeedsALookProducer[]) {
        this.producers = [...(producers ?? [])];
    }

    /** Add a producer from a module that cannot extend the token's list. Idempotent per id. */
    register(producer: NeedsALookProducer): void {
        if (this.producers.some((existing) => existing.id === producer.id)) return;
        this.producers.push(producer);
    }

    /** The ids of every registered producer, in registration order. */
    producerIds(): string[] {
        return this.producers.map((producer) => producer.id);
    }

    async forNodes(
        nodes: readonly FleetNodeView[],
        context: Partial<NeedsALookContext> = {},
    ): Promise<NeedsALookResult> {
        const resolved: NeedsALookContext = { now: context.now ?? new Date() };
        const settled = await Promise.allSettled(
            this.producers.map(async (producer) => producer.produce(nodes, resolved)),
        );
        let partial = false;
        const byId = new Map<string, NeedsALookItem>();
        settled.forEach((outcome, index) => {
            if (outcome.status === 'rejected') {
                partial = true;
                const reason =
                    outcome.reason instanceof Error
                        ? outcome.reason.message
                        : String(outcome.reason);
                this.logger.warn(
                    `Needs-a-look producer ${this.producers[index].id} failed: ${reason}`,
                );
                return;
            }
            for (const item of Array.isArray(outcome.value) ? outcome.value : []) {
                if (!byId.has(item.id)) byId.set(item.id, item);
            }
        });
        return { items: sortNeedsALook([...byId.values()]), partial };
    }
}
