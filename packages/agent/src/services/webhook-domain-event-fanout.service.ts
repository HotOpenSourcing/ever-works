import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnApplicationBootstrap,
    type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { type DomainEventEnvelope, matchesAnyDomainEventPattern } from '@ever-works/contracts';
import { WebhookDeliveryRepository } from '../database/repositories/webhook-delivery.repository';
import { WebhookSubscriptionRepository } from '../database/repositories/webhook-subscription.repository';
import { seqToBigInt } from '../domain-events/domain-event-envelope';
import {
    DomainEventCursorExpiredError,
    DomainEventFeedService,
} from '../domain-events/domain-event-feed.service';
import { PLUGIN_EVENT_ANCHOR_TENANT_ID } from '../domain-events/domain-event-plugin-delivery.service';
import { DomainEventRelayService } from '../domain-events/domain-event-relay.service';
import { ApiKey } from '../entities/api-key.entity';
import { Organization } from '../entities/organization.entity';
import { PluginEventCursor } from '../entities/plugin-event-cursor.entity';
import { User } from '../entities/user.entity';
import type { WebhookSubscription } from '../entities/webhook-subscription.entity';

/**
 * Enqueues a `webhook_deliveries` row the fan-out created on the platform's
 * delivery pipeline (the API binds it to `WebhookEventDispatcherService`:
 * Trigger.dev `webhook-delivery`, or in process).
 */
export interface WebhookV2Enqueuer {
    enqueueDelivery(payload: {
        readonly deliveryId: string;
        readonly subscriptionId: string;
        readonly eventName: string;
        readonly payload: Record<string, unknown>;
    }): Promise<unknown>;
}

/** DI token for {@link WebhookV2Enqueuer}. Unbound → deliveries are created but not enqueued. */
export const WEBHOOK_V2_ENQUEUER = Symbol.for('WebhookV2Enqueuer');

/** The fan-out's cursor row in `plugin_event_cursors` (one global position, anchor tenant). */
export const WEBHOOKS_V2_CURSOR_ID = 'core:webhooks-v2';

/** Events read per page, and pages per pass (a pass yields after this many). */
const PAGE_SIZE = 200;
const MAX_PAGES_PER_PASS = 25;
/** The leader's catch-up timer: picks up anything a crash or a slow pass left behind. */
const CATCH_UP_INTERVAL_MS = 10_000;

/** Whether a subscription's owner may receive its events right now (and where). */
interface OwnerVerdict {
    readonly ok: boolean;
    /** Not ok AND permanently so (owner gone / key revoked): mark the subscription `disabled`. */
    readonly disable: boolean;
    /** The organizations the owner can still see; `null` = no restriction beyond the subscription's. */
    readonly organizationIds: ReadonlySet<string> | null;
}

const DENIED_FOR_NOW: OwnerVerdict = { ok: false, disable: false, organizationIds: null };
const DENIED_FOR_GOOD: OwnerVerdict = { ok: false, disable: true, organizationIds: null };

/**
 * Webhooks v2 fan-out (EW-P1-5, integration contract v1 B.5).
 *
 * Turns dispatched domain events into `webhook_deliveries` for every active
 * `version = 2` subscription they match, then enqueues them on the existing
 * delivery pipeline (Trigger.dev `webhook-delivery`, or in process), which
 * signs them `X-Ever-Works-Signature: t=,v1=` and retries 5xx / timeouts on the
 * 30 s → 24 h ladder.
 *
 * **At least once, idempotent.** The fan-out reads the change feed from its own
 * cursor (`plugin_event_cursors`, plugin id {@link WEBHOOKS_V2_CURSOR_ID}) and
 * only moves it after the page's deliveries exist; the unique
 * `(subscriptionId, eventId)` index turns a re-run into a no-op. It runs on the
 * relay leader: as a relay consumer right after each dispatch (low latency) and
 * on a 10 s catch-up timer (a crash between dispatch and fan-out loses nothing).
 *
 * **What a subscription receives** — exactly what the integration feed would
 * serve its owner, restricted by the subscription:
 *  - events of its `organizationIds` (never personal scope, never `private`
 *    aggregates except the id-only `*.visibility_changed` notice — the feed's
 *    rules, applied by {@link DomainEventFeedService});
 *  - whose type matches its `events` (opt-in types only by exact name);
 *  - whose `origin.tag` is not in its `excludeOriginTags` (loop guard);
 *  - that occurred after the subscription was created;
 *  - while its owner still has access: a user owner must still belong to the
 *    event's tenant; an integration-key owner must be active, unexpired and
 *    still pinned to the event's organization. A subscription whose owner is
 *    gone or revoked is marked `disabled`.
 */
@Injectable()
export class WebhookDomainEventFanoutService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(WebhookDomainEventFanoutService.name);
    private timer: NodeJS.Timeout | null = null;
    private inFlight: Promise<number> | null = null;
    private rerun = false;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly subscriptions: WebhookSubscriptionRepository,
        private readonly deliveries: WebhookDeliveryRepository,
        private readonly feed: DomainEventFeedService,
        @Optional()
        @Inject(WEBHOOK_V2_ENQUEUER)
        private readonly enqueuer?: WebhookV2Enqueuer,
        @Optional() private readonly relay?: DomainEventRelayService,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.relay) return;
        this.relay.registerConsumer({
            name: 'webhooks-v2',
            // The batch itself is not needed: the pass reads from the cursor, so it
            // also covers anything an earlier pass missed.
            consume: async () => {
                await this.catchUp();
            },
        });
        if (process.env.NODE_ENV === 'test') return;
        this.timer = setInterval(() => {
            if (!this.relay?.isLeader()) return;
            void this.catchUp().catch((error) =>
                this.logger.warn(`webhooks v2 catch-up failed: ${describe(error)}`),
            );
        }, CATCH_UP_INTERVAL_MS);
        this.timer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * One fan-out pass from the cursor (single-flight: a call while a pass runs
     * schedules one more pass and shares the running one). Returns the number
     * of deliveries created.
     */
    catchUp(): Promise<number> {
        if (this.inFlight) {
            this.rerun = true;
            return this.inFlight;
        }
        const run = (async () => {
            let created = 0;
            do {
                this.rerun = false;
                created += await this.pass();
            } while (this.rerun);
            return created;
        })().finally(() => {
            this.inFlight = null;
        });
        this.inFlight = run;
        return run;
    }

    private async pass(): Promise<number> {
        const cursor = await this.loadCursor();
        const subscriptions = (await this.subscriptions.listActiveV2()).filter(
            (sub) => (sub.organizationIds?.length ?? 0) > 0 && (sub.events?.length ?? 0) > 0,
        );
        if (subscriptions.length === 0) {
            // Nobody listens: keep the cursor at the head so a new subscription
            // starts from now, not from the whole retained history.
            await this.moveCursor(cursor, await this.feed.head());
            return 0;
        }

        const organizationIds = [...new Set(subscriptions.flatMap((sub) => sub.organizationIds ?? []))];
        const patterns = [...new Set(subscriptions.flatMap((sub) => sub.events ?? []))];
        const owners = new Map<string, OwnerVerdict>();
        let after = cursor.lastSeq;
        let created = 0;

        for (let page = 0; page < MAX_PAGES_PER_PASS; page++) {
            let result;
            try {
                result = await this.feed.readPage({
                    organizationIds,
                    after,
                    limit: PAGE_SIZE,
                    types: patterns,
                });
            } catch (error) {
                if (error instanceof DomainEventCursorExpiredError) {
                    // Retention purged events this fan-out never saw (the API was down
                    // longer than the window). Receivers fill such gaps from GET /events.
                    this.logger.warn(
                        `webhooks v2 fan-out fell behind retention (cursor ${after}, floor ${error.floor}); skipping ahead`,
                    );
                    after = error.floor;
                    await this.moveCursor(cursor, after);
                    continue;
                }
                throw error;
            }

            for (const event of result.events) {
                for (const sub of subscriptions) {
                    if (!this.matches(sub, event)) continue;
                    const owner = await this.ownerVerdict(sub, owners);
                    if (!owner.ok) continue;
                    if (owner.organizationIds && !owner.organizationIds.has(event.organizationId ?? '')) {
                        continue;
                    }
                    if (await this.deliver(sub, event)) created += 1;
                }
            }

            if (result.nextCursor) {
                after = result.nextCursor;
                await this.moveCursor(cursor, after);
            }
            if (!result.hasMore) break;
        }
        return created;
    }

    /** The subscription's own filters (organization, type pattern, origin loop guard, creation time). */
    private matches(sub: WebhookSubscription, event: DomainEventEnvelope): boolean {
        if (!event.organizationId || !(sub.organizationIds ?? []).includes(event.organizationId)) {
            return false;
        }
        if (!matchesAnyDomainEventPattern(event.type, sub.events ?? [])) return false;
        if (event.origin.tag && (sub.excludeOriginTags ?? []).includes(event.origin.tag)) {
            return false;
        }
        const createdAt = sub.createdAt instanceof Date ? sub.createdAt.getTime() : 0;
        return Date.parse(event.occurredAt) >= createdAt - 1000;
    }

    /** Whether the owner may still receive the subscription's events (cached per pass). */
    private async ownerVerdict(
        sub: WebhookSubscription,
        cache: Map<string, OwnerVerdict>,
    ): Promise<OwnerVerdict> {
        const cached = cache.get(sub.id);
        if (cached) return cached;
        const verdict = await this.resolveOwner(sub);
        if (!verdict.ok && verdict.disable) {
            await this.subscriptions.markDisabled(sub.id);
            this.logger.warn(
                `webhooks v2 subscription ${sub.id} disabled: its ${sub.ownerType} owner no longer has access`,
            );
        }
        cache.set(sub.id, verdict);
        return verdict;
    }

    private async resolveOwner(sub: WebhookSubscription): Promise<OwnerVerdict> {
        const ownerId = sub.ownerId ?? sub.accountId;
        if (sub.ownerType === 'integration_key') {
            const key = await this.dataSource.getRepository(ApiKey).findOne({ where: { id: ownerId } });
            if (!key || !key.isActive || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
                return DENIED_FOR_GOOD;
            }
            const pinned = (key as unknown as { organizationIds?: string[] | null }).organizationIds;
            return {
                ok: true,
                disable: false,
                organizationIds: Array.isArray(pinned) ? new Set(pinned) : new Set<string>(),
            };
        }
        const user = await this.dataSource
            .getRepository(User)
            .findOne({ where: { id: ownerId }, select: ['id', 'tenantId'] });
        if (!user) return DENIED_FOR_GOOD;
        if (!user.tenantId) return DENIED_FOR_NOW;
        // A user belongs to an organization through its tenant (OrganizationMembershipService).
        const tenantOrgs = await this.organizationsOfTenant(user.tenantId);
        return { ok: true, disable: false, organizationIds: tenantOrgs };
    }

    private async organizationsOfTenant(tenantId: string): Promise<ReadonlySet<string>> {
        const rows = await this.dataSource
            .getRepository(Organization)
            .find({ where: { tenantId }, select: ['id'] });
        return new Set(rows.map((row) => row.id));
    }

    /** Create the pending delivery (idempotent) and enqueue it. */
    private async deliver(sub: WebhookSubscription, event: DomainEventEnvelope): Promise<boolean> {
        const payload = event as unknown as Record<string, unknown>;
        const delivery = await this.deliveries.createPendingForEvent({
            subscriptionId: sub.id,
            accountId: sub.accountId,
            event: event.type,
            eventId: event.id,
            payload,
            tenantId: event.tenantId,
            organizationId: event.organizationId,
        });
        if (!delivery) return false;
        if (!this.enqueuer) {
            this.logger.warn(`webhooks v2 delivery ${delivery.id} created but no enqueuer is bound`);
            return true;
        }
        await this.enqueuer.enqueueDelivery({
            deliveryId: delivery.id,
            subscriptionId: sub.id,
            eventName: event.type,
            payload,
        });
        return true;
    }

    // ── cursor ─────────────────────────────────────────────────────────────

    private async loadCursor(): Promise<{ id: string; lastSeq: string }> {
        const repo = this.dataSource.getRepository(PluginEventCursor);
        const existing = await repo.findOne({
            where: { pluginId: WEBHOOKS_V2_CURSOR_ID, tenantId: PLUGIN_EVENT_ANCHOR_TENANT_ID },
        });
        if (existing) return { id: existing.id, lastSeq: String(existing.lastSeq ?? '0') };
        // First run: start at the head — v2 subscriptions receive new events.
        const head = await this.feed.head();
        try {
            await repo.insert({
                pluginId: WEBHOOKS_V2_CURSOR_ID,
                tenantId: PLUGIN_EVENT_ANCHOR_TENANT_ID,
                lastSeq: head,
                consecutiveFailures: 0,
            } as Partial<PluginEventCursor>);
        } catch {
            // Another replica created it first.
        }
        const row = await repo.findOneOrFail({
            where: { pluginId: WEBHOOKS_V2_CURSOR_ID, tenantId: PLUGIN_EVENT_ANCHOR_TENANT_ID },
        });
        return { id: row.id, lastSeq: String(row.lastSeq ?? '0') };
    }

    /** Move the cursor forward only (compare-and-set on the value it was read at). */
    private async moveCursor(cursor: { id: string; lastSeq: string }, to: string): Promise<void> {
        if (seqToBigInt(to) <= seqToBigInt(cursor.lastSeq)) return;
        const escape = (name: string) => this.dataSource.driver.escape(name);
        const result = await this.dataSource
            .createQueryBuilder()
            .update(PluginEventCursor)
            .set({ lastSeq: to })
            .where(`${escape('id')} = :id`, { id: cursor.id })
            .andWhere(`${escape('lastSeq')} = :from`, { from: cursor.lastSeq })
            .execute();
        if ((result.affected ?? 0) > 0) cursor.lastSeq = to;
        else {
            // Someone else moved it (another pass): re-read, never move it back.
            const row = await this.dataSource
                .getRepository(PluginEventCursor)
                .findOne({ where: { id: cursor.id } });
            if (row) cursor.lastSeq = String(row.lastSeq ?? cursor.lastSeq);
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
