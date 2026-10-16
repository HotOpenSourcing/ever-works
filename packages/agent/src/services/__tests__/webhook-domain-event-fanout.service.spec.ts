import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import { WebhookDeliveryRepository } from '../../database/repositories/webhook-delivery.repository';
import { WebhookSubscriptionRepository } from '../../database/repositories/webhook-subscription.repository';
import { DomainEventFeedService } from '../../domain-events/domain-event-feed.service';
import { DomainEventRecorder, type RecordDomainEventInput } from '../../domain-events/domain-event-recorder.service';
import { DomainEventRelayService } from '../../domain-events/domain-event-relay.service';
import { DomainEventRetentionService } from '../../domain-events/domain-event-retention.service';
import {
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
    resetDomainEventsTables,
    taskEventInput,
    TENANT,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { PluginEventCursor } from '../../entities/plugin-event-cursor.entity';
import { User } from '../../entities/user.entity';
import { WebhookDelivery } from '../../entities/webhook-delivery.entity';
import { WebhookSubscription } from '../../entities/webhook-subscription.entity';
import {
    WEBHOOKS_V2_CURSOR_ID,
    WebhookDomainEventFanoutService,
    type WebhookV2Enqueuer,
} from '../webhook-domain-event-fanout.service';

/**
 * Webhooks v2 fan-out (EW-P1-5) on SQLite: real recorder, relay, feed and
 * repositories; only the enqueue port is a double.
 */
describe('WebhookDomainEventFanoutService', () => {
    let dataSource: DataSource;
    let fanout: WebhookDomainEventFanoutService;
    let subscriptions: WebhookSubscriptionRepository;
    const enqueued: Array<{ subscriptionId: string; eventName: string; payload: Record<string, unknown> }> = [];
    const enqueuer: WebhookV2Enqueuer = {
        enqueueDelivery: async (payload) => {
            enqueued.push(payload);
            return null;
        },
    };
    const OWNER = randomUUID();
    const OTHER_TENANT = randomUUID();

    const record = async (overrides: Partial<RecordDomainEventInput> = {}) => {
        const recorder = new DomainEventRecorder();
        await dataSource.transaction((manager) => recorder.record(manager, taskEventInput(overrides)));
    };
    const dispatch = async () => {
        const relay = new DomainEventRelayService(
            dataSource,
            new DomainEventRetentionService(dataSource),
            new EventEmitter2(),
        );
        await relay.tick();
        await relay.stop();
    };
    const deliveries = () =>
        dataSource.getRepository(WebhookDelivery).find({ order: { createdAt: 'ASC' } });
    const subscribe = (overrides: Partial<Parameters<WebhookSubscriptionRepository['createV2']>[0]> = {}) =>
        subscriptions.createV2({
            accountId: OWNER,
            ownerType: 'user',
            ownerId: OWNER,
            url: 'https://hooks.example.com/ever',
            secretEncrypted: 'secret',
            events: ['task.*'],
            organizationIds: [ORG_A],
            excludeOriginTags: [],
            description: null,
            ...overrides,
        });

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        subscriptions = new WebhookSubscriptionRepository(dataSource.getRepository(WebhookSubscription));
        fanout = new WebhookDomainEventFanoutService(
            dataSource,
            subscriptions,
            new WebhookDeliveryRepository(dataSource.getRepository(WebhookDelivery)),
            new DomainEventFeedService(dataSource),
            enqueuer,
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of ['webhook_deliveries', 'webhook_subscriptions', 'users', 'organizations', 'api_keys']) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        enqueued.length = 0;
        await dataSource.getRepository(Organization).insert([
            { id: ORG_A, tenantId: TENANT, slug: `a-${randomUUID().slice(0, 6)}`, displayName: 'A' },
            { id: ORG_B, tenantId: OTHER_TENANT, slug: `b-${randomUUID().slice(0, 6)}`, displayName: 'B' },
        ] as unknown as Organization[]);
        await dataSource.getRepository(User).insert({
            id: OWNER,
            username: 'owner',
            slug: `owner-${OWNER.slice(0, 6)}`,
            tenantId: TENANT,
        } as unknown as User);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('starts at the head: events before the first pass are not delivered', async () => {
        await record();
        await dispatch();
        await subscribe();
        expect(await fanout.catchUp()).toBe(0);
        const cursor = await dataSource
            .getRepository(PluginEventCursor)
            .findOneByOrFail({ pluginId: WEBHOOKS_V2_CURSOR_ID });
        expect(String(cursor.lastSeq)).toBe('1');
    });

    it('delivers what matches the organization, type pattern and origin filter — once', async () => {
        await fanout.catchUp(); // cursor at the (empty) head
        const sub = await subscribe({ excludeOriginTags: ['gauzy:conn-1'] });
        await record({ type: 'task.updated' });
        await record({ type: 'team.created', aggregate: { type: 'team', id: randomUUID(), version: 1 }, data: { id: 'x', visibility: 'organization' } });
        await record({ type: 'task.updated', organizationId: ORG_B, tenantId: OTHER_TENANT });
        await record({ type: 'task.updated', originTag: 'gauzy:conn-1' });
        await record({ type: 'task.runtime_updated' });
        await dispatch();

        expect(await fanout.catchUp()).toBe(1);
        const rows = await deliveries();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ subscriptionId: sub.id, event: 'task.updated', status: 'pending' });
        expect(rows[0].eventId).toMatch(/^evt_/);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].payload).toMatchObject({
            id: rows[0].eventId,
            type: 'task.updated',
            organizationId: ORG_A,
            seq: '1',
        });

        // Re-running (at least once) creates nothing new.
        await dataSource
            .getRepository(PluginEventCursor)
            .update({ pluginId: WEBHOOKS_V2_CURSOR_ID }, { lastSeq: 0 });
        expect(await fanout.catchUp()).toBe(0);
        expect(await deliveries()).toHaveLength(1);
    });

    it('delivers an opt-in type only to a subscription that names it exactly', async () => {
        await fanout.catchUp();
        await subscribe({ events: ['task.runtime_updated'] });
        await subscribe({ events: ['*'] });
        await record({ type: 'task.runtime_updated' });
        await dispatch();
        expect(await fanout.catchUp()).toBe(1);
        expect((await deliveries()).map((row) => row.event)).toEqual(['task.runtime_updated']);
    });

    it('never delivers private aggregates, except the id-only visibility notice', async () => {
        await fanout.catchUp();
        await subscribe({ events: ['*'] });
        await record({ type: 'task.updated', visibility: 'private' });
        await record({
            type: 'task.visibility_changed',
            visibility: 'private',
            data: { id: 'x', visibility: 'private' },
        });
        await dispatch();
        await fanout.catchUp();
        expect((await deliveries()).map((row) => row.event)).toEqual(['task.visibility_changed']);
    });

    it('stops delivering when the user owner left the tenant, and disables it when the user is gone', async () => {
        await fanout.catchUp();
        const sub = await subscribe();
        await dataSource.getRepository(User).update({ id: OWNER }, { tenantId: OTHER_TENANT });
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(0);

        await dataSource.getRepository(User).delete({ id: OWNER });
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(0);
        expect((await subscriptions.findById(sub.id))?.status).toBe('disabled');
    });

    it('disables a subscription whose integration key was revoked', async () => {
        await fanout.catchUp();
        const keyId = randomUUID();
        await dataSource.getRepository(ApiKey).insert({
            id: keyId,
            userId: OWNER,
            name: 'gauzy',
            hashedKey: `h-${keyId}`,
            prefix: 'ew_int_x',
            isActive: false,
        } as unknown as ApiKey);
        const sub = await subscribe({ ownerType: 'integration_key', ownerId: keyId });
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(0);
        expect((await subscriptions.findById(sub.id))?.status).toBe('disabled');
    });

    it('ignores v1 subscriptions and paused v2 ones', async () => {
        await fanout.catchUp();
        await subscriptions.createForAccount({ accountId: OWNER, url: 'https://v1.example.com', secretEncrypted: 's' });
        const paused = await subscribe();
        await subscriptions.pause(paused.id);
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(0);
        expect(await deliveries()).toEqual([]);
    });
});
