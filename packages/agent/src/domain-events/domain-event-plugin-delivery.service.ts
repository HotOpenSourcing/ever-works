import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { matchesAnyDomainEventPattern } from '@ever-works/contracts';
import {
    DOMAIN_EVENT_SUBSCRIBER_CAPABILITY,
    isDomainEventSubscriberPlugin,
    type IDomainEventSubscriberPlugin,
} from '@ever-works/plugin';
import { DataSource, MoreThan } from 'typeorm';
import { DomainEvent } from '../entities/domain-event.entity';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../entities/domain-event-relay-state.entity';
import { PluginEventCursor } from '../entities/plugin-event-cursor.entity';
import { Tenant } from '../entities/tenant.entity';
import { materializePlugin } from '../plugins/services/plugin-operation.util';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { seqToBigInt, toDomainEventEnvelope } from './domain-event-envelope';
import { DOMAIN_EVENT_PLUGIN_MAX_FAILURES, readDomainEventsSettings } from './domain-events.config';

/**
 * The cursor row a plugin gets on first sight: where tenants with no cursor of
 * their own start (the head at the time the plugin was first seen), so a newly
 * installed plugin receives new events, not the whole retained history.
 */
export const PLUGIN_EVENT_ANCHOR_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Events read per plugin per pass. */
const PLUGIN_BATCH = 200;

/** A loaded, enabled-somewhere subscriber, ready to call. */
export interface ResolvedDomainEventSubscriber {
    readonly pluginId: string;
    readonly plugin: IDomainEventSubscriberPlugin;
}

/**
 * Delivers dispatched domain events to `domain-event-subscriber` plugins
 * (EW-P1-1, spec §6) — at least once, per plugin and tenant, in `seq` order.
 *
 * - A tenant receives events only while the plugin is enabled for it (enabled
 *   for the tenant's owner, or system/auto-enabled).
 * - The cursor (`plugin_event_cursors.lastSeq`) moves only after
 *   `onDomainEvent` resolves within the timeout; a failure stops that tenant's
 *   delivery for this pass (later events wait, order is kept) and is retried on
 *   the next pass.
 * - After {@link DOMAIN_EVENT_PLUGIN_MAX_FAILURES} consecutive failures on one
 *   event, the event is dead-lettered: logged, counted, and passed.
 *
 * Called by the relay on every tick while it is the leader.
 */
@Injectable()
export class DomainEventPluginDeliveryService {
    private readonly logger = new Logger(DomainEventPluginDeliveryService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @Optional() private readonly registry?: PluginRegistryService,
    ) {}

    /** The loaded plugins that declare the capability and implement the contract. */
    async subscribers(): Promise<ResolvedDomainEventSubscriber[]> {
        if (!this.registry) return [];
        const resolved: ResolvedDomainEventSubscriber[] = [];
        for (const entry of this.registry.getByCapability(DOMAIN_EVENT_SUBSCRIBER_CAPABILITY)) {
            if (entry.state === 'error') continue;
            try {
                const instance = (await materializePlugin(entry.plugin)) ?? entry.plugin;
                if (isDomainEventSubscriberPlugin(instance)) {
                    resolved.push({ pluginId: entry.plugin.id, plugin: instance });
                }
            } catch (error) {
                this.logger.warn(
                    `Could not load domain event subscriber ${entry.plugin.id}: ${describe(error)}`,
                );
            }
        }
        return resolved;
    }

    /** One delivery pass for every subscriber. */
    async deliverPending(subscribers?: readonly ResolvedDomainEventSubscriber[]): Promise<void> {
        const list = subscribers ?? (await this.subscribers());
        for (const subscriber of list) {
            try {
                await this.deliverFor(subscriber);
            } catch (error) {
                this.logger.warn(
                    `Domain event delivery to ${subscriber.pluginId} failed: ${describe(error)}`,
                );
            }
        }
    }

    /** One pass for one plugin. Public for tests. */
    async deliverFor(subscriber: ResolvedDomainEventSubscriber): Promise<void> {
        const { pluginId, plugin } = subscriber;
        const cursorRepo = this.dataSource.getRepository(PluginEventCursor);
        const cursors = await cursorRepo.find({ where: { pluginId } });

        let anchor = cursors.find((cursor) => cursor.tenantId === PLUGIN_EVENT_ANCHOR_TENANT_ID);
        if (!anchor) {
            const state = await this.dataSource
                .getRepository(DomainEventRelayState)
                .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } });
            await cursorRepo
                .createQueryBuilder()
                .insert()
                .into(PluginEventCursor)
                .values({
                    pluginId,
                    tenantId: PLUGIN_EVENT_ANCHOR_TENANT_ID,
                    lastSeq: seqToBigInt(state?.lastSeq).toString(),
                })
                .orIgnore()
                .execute();
            return;
        }

        const byTenant = new Map(
            cursors
                .filter((cursor) => cursor.tenantId !== PLUGIN_EVENT_ANCHOR_TENANT_ID)
                .map((cursor) => [cursor.tenantId, cursor]),
        );
        const anchorSeq = seqToBigInt(anchor.lastSeq);
        let from = anchorSeq;
        for (const cursor of byTenant.values()) {
            const seq = seqToBigInt(cursor.lastSeq);
            if (seq < from) from = seq;
        }

        const events = await this.dataSource.getRepository(DomainEvent).find({
            where: { seq: MoreThan(from.toString() as unknown as number) },
            order: { seq: 'ASC' },
            take: PLUGIN_BATCH,
        });
        if (events.length === 0) return;

        const timeoutMs = readDomainEventsSettings().pluginTimeoutMs;
        const blocked = new Set<string>();
        const dirty = new Map<string, PluginEventCursor>();
        const enabledCache = new Map<string, boolean>();

        for (const row of events) {
            const tenantId = row.tenantId;
            if (!tenantId || blocked.has(tenantId)) continue;
            const seq = seqToBigInt(row.seq);
            let cursor = byTenant.get(tenantId);
            if (!cursor) {
                cursor = cursorRepo.create({
                    pluginId,
                    tenantId,
                    lastSeq: anchorSeq.toString(),
                    consecutiveFailures: 0,
                    deadLetterCount: 0,
                });
                byTenant.set(tenantId, cursor);
            }
            if (seq <= seqToBigInt(cursor.lastSeq)) continue;

            const wanted = matchesAnyDomainEventPattern(row.type, plugin.subscribes);
            if (!wanted || !(await this.isEnabledForTenant(pluginId, tenantId, enabledCache))) {
                cursor.lastSeq = seq.toString();
                dirty.set(tenantId, cursor);
                continue;
            }

            const attempt = (cursor.consecutiveFailures ?? 0) + 1;
            try {
                await callWithTimeout(
                    (signal) =>
                        plugin.onDomainEvent(toDomainEventEnvelope(row), {
                            tenantId,
                            attempt,
                            signal,
                        }),
                    timeoutMs,
                );
                cursor.lastSeq = seq.toString();
                cursor.consecutiveFailures = 0;
            } catch (error) {
                cursor.consecutiveFailures = attempt;
                cursor.lastError = describe(error).slice(0, 2000);
                cursor.lastErrorAt = new Date();
                if (attempt >= DOMAIN_EVENT_PLUGIN_MAX_FAILURES) {
                    this.logger.error(
                        `Dead-lettering ${row.id} (${row.type}) for plugin ${pluginId} after ${attempt} failures: ${cursor.lastError}`,
                    );
                    cursor.lastSeq = seq.toString();
                    cursor.consecutiveFailures = 0;
                    cursor.deadLetterCount = (cursor.deadLetterCount ?? 0) + 1;
                    cursor.lastDeadLetterEventId = row.id;
                } else {
                    blocked.add(tenantId);
                }
            }
            dirty.set(tenantId, cursor);
        }

        if (dirty.size > 0) await cursorRepo.save([...dirty.values()]);
        // Tenants with no cursor of their own start from the anchor: move it past
        // everything this pass looked at, since every tenant seen now has its own row.
        const lastSeen = seqToBigInt(events[events.length - 1].seq);
        if (lastSeen > anchorSeq) {
            anchor.lastSeq = lastSeen.toString();
            await cursorRepo.save(anchor);
        }
    }

    private async isEnabledForTenant(
        pluginId: string,
        tenantId: string,
        cache: Map<string, boolean>,
    ): Promise<boolean> {
        const cached = cache.get(tenantId);
        if (cached !== undefined) return cached;
        let enabled = false;
        if (this.registry) {
            const tenant = await this.dataSource
                .getRepository(Tenant)
                .findOne({ where: { id: tenantId } });
            enabled = await this.registry.isPluginEnabledForScope(
                pluginId,
                undefined,
                tenant?.ownerUserId,
            );
        }
        cache.set(tenantId, enabled);
        return enabled;
    }
}

/** Run `fn` with an abort signal that fires after `timeoutMs`; reject on timeout. */
async function callWithTimeout(
    fn: (signal: AbortSignal) => Promise<void>,
    timeoutMs: number,
): Promise<void> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref?.();
    });
    try {
        await Promise.race([fn(controller.signal), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
