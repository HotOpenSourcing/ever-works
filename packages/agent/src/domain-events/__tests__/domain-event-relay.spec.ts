import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEventEnvelope } from '@ever-works/contracts';
import type { DataSource } from 'typeorm';
import { DomainEvent } from '../../entities/domain-event.entity';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../../entities/domain-event-relay-state.entity';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import { DomainEventRelayService } from '../domain-event-relay.service';
import { DomainEventRetentionService } from '../domain-event-retention.service';
import {
    createDomainEventsDataSource,
    recordMany,
    resetDomainEventsTables,
    taskEventInput,
} from './domain-events.test-helpers';

describe('DomainEventRelayService', () => {
    let dataSource: DataSource;
    let emitter: EventEmitter2;

    const relay = (events: EventEmitter2 | undefined = emitter) =>
        new DomainEventRelayService(
            dataSource,
            new DomainEventRetentionService(dataSource),
            events,
        );
    const positions = async () =>
        (await dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } })).map(
            (row) => (row.seq === null || row.seq === undefined ? null : String(row.seq)),
        );
    const lastSeq = async () =>
        String(
            (
                await dataSource
                    .getRepository(DomainEventRelayState)
                    .findOneByOrFail({ id: DOMAIN_EVENT_RELAY_STATE_ID })
            ).lastSeq,
        );

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        emitter = new EventEmitter2();
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('takes the lease, gives committed rows gap-free positions in insert order and advances lastSeq', async () => {
        await recordMany(dataSource, 3);
        const result = await relay().tick();
        expect(result).toEqual({ leader: true, dispatched: 3 });
        expect(await positions()).toEqual(['1', '2', '3']);
        expect(await lastSeq()).toBe('3');
        const rows = await dataSource.getRepository(DomainEvent).find();
        expect(
            rows.every(
                (row) => row.dispatchedAt instanceof Date || typeof row.dispatchedAt === 'string',
            ),
        ).toBe(true);
    });

    it('emits every dispatched envelope as domain.<type>, in seq order', async () => {
        const seen: DomainEventEnvelope[] = [];
        emitter.on('domain.task.updated', (envelope: DomainEventEnvelope) => {
            seen.push(envelope);
        });
        await recordMany(dataSource, 2);
        await relay().tick();
        expect(seen.map((envelope) => envelope.seq)).toEqual(['1', '2']);
        expect(seen[0]).toMatchObject({
            type: 'task.updated',
            version: 1,
            aggregate: { type: 'task', version: 2 },
        });
    });

    it('keeps going when a listener throws (in-process delivery never blocks the relay)', async () => {
        emitter.on('domain.task.updated', () => {
            throw new Error('listener bug');
        });
        await recordMany(dataSource, 2);
        const result = await relay().tick();
        expect(result.dispatched).toBe(2);
        expect(await lastSeq()).toBe('2');
    });

    it('gives a row that commits AFTER later rows a later position, so the feed never skips it', async () => {
        const recorder = new DomainEventRecorder();
        const leader = relay();
        // Rows 1 and 2 commit and are dispatched.
        await recordMany(dataSource, 2);
        await leader.tick();
        // A "slow" row: inserted with a LOWER outboxSeq than an already-dispatched
        // row would have, simulated by inserting it now and checking it is not
        // squeezed below the existing positions.
        await dataSource.transaction((manager) => recorder.record(manager, taskEventInput()));
        await leader.tick();
        expect(await positions()).toEqual(['1', '2', '3']);
    });

    it('lets exactly one of two replicas lead', async () => {
        const first = relay();
        const second = relay();
        await recordMany(dataSource, 1);
        const [a, b] = [await first.tick(), await second.tick()];
        expect([a.leader, b.leader]).toEqual([true, false]);
        expect(b.dispatched).toBe(0);
        expect(await lastSeq()).toBe('1');
    });

    it('hands over when the leader stops and releases its lease', async () => {
        const first = relay();
        const second = relay();
        await first.tick();
        await first.stop();
        await recordMany(dataSource, 1);
        const result = await second.tick();
        expect(result).toEqual({ leader: true, dispatched: 1 });
    });

    it('takes over an expired lease, and the old holder is fenced off', async () => {
        const first = relay();
        const second = relay();
        await first.tick(new Date('2026-10-15T18:00:00Z'));
        await recordMany(dataSource, 1);
        // 31 s later the first lease (30 s) has expired: the second replica takes it.
        const later = new Date('2026-10-15T18:00:31Z');
        const taken = await second.tick(later);
        expect(taken).toEqual({ leader: true, dispatched: 1 });
        // The first replica still believes it leads, but its renewal fails.
        await recordMany(dataSource, 1);
        const fenced = await first.tick(new Date('2026-10-15T18:00:32Z'));
        expect(fenced).toEqual({ leader: false, dispatched: 0 });
        expect(await lastSeq()).toBe('1');
    });

    it('hands every dispatched batch to registered consumers', async () => {
        const batches: string[][] = [];
        const leader = relay();
        leader.registerConsumer({
            name: 'test',
            consume: async (events) => {
                batches.push(events.map((event) => event.seq));
            },
        });
        await recordMany(dataSource, 2);
        await leader.tick();
        expect(batches).toEqual([['1', '2']]);
    });

    it('does nothing when there is nothing to dispatch', async () => {
        expect(await relay().tick()).toEqual({ leader: true, dispatched: 0 });
        expect(await lastSeq()).toBe('0');
    });

    it('does not start when DOMAIN_EVENTS_RELAY_ENABLED=false', async () => {
        const previous = process.env.DOMAIN_EVENTS_RELAY_ENABLED;
        process.env.DOMAIN_EVENTS_RELAY_ENABLED = 'false';
        try {
            const disabled = relay();
            await disabled.start();
            await recordMany(dataSource, 1);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(await positions()).toEqual([null]);
            expect(disabled.isLeader()).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.DOMAIN_EVENTS_RELAY_ENABLED;
            else process.env.DOMAIN_EVENTS_RELAY_ENABLED = previous;
        }
    });
});
