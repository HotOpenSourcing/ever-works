import Redis from 'ioredis';
import {
    decodeRelayEnvelope,
    encodeRelayEnvelope,
    isRelayBusTopic,
    newRelayReplicaId,
    type RelayBus,
} from '../relay-bus';
import { InProcessRelayBus } from '../relay-bus.in-process';
import { ValkeyRelayBus, type RelayRedisClient } from '../relay-bus.valkey';
import { FakeValkey, flushBus } from './relay-test-kit';

/**
 * The relay bus over Valkey (FL-02, CONTRACTS R-7, spec FR-29): round trips
 * between replicas, no loop-back, addressed messages, presence, a degraded
 * connection, and `claimOnce` held fleet-wide. Every case runs against an
 * in-memory Valkey; with `FLEET_RELAY_TEST_REDIS_URL` set the same cases run
 * against that server too.
 */

const REAL_URL = process.env.FLEET_RELAY_TEST_REDIS_URL;

interface Backend {
    name: string;
    make(): { a: ValkeyRelayBus; b: ValkeyRelayBus; cut?: () => void; restore?: () => void };
}

const buses: RelayBus[] = [];

const fakeBackend: Backend = {
    name: 'in-memory Valkey',
    make() {
        const hub = new FakeValkey();
        const create = () => hub.client();
        const a = new ValkeyRelayBus({ url: 'redis://fake', createClient: create });
        const b = new ValkeyRelayBus({ url: 'redis://fake', createClient: create });
        buses.push(a, b);
        return { a, b, cut: () => hub.cutAll(), restore: () => hub.restoreAll() };
    },
};

const realBackend: Backend = {
    name: 'Valkey at FLEET_RELAY_TEST_REDIS_URL',
    make() {
        const a = new ValkeyRelayBus({ url: REAL_URL! });
        const b = new ValkeyRelayBus({ url: REAL_URL! });
        buses.push(a, b);
        return { a, b };
    },
};

afterEach(async () => {
    await Promise.all(buses.splice(0).map((bus) => bus.close()));
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await flushBus(2);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('relay bus envelope', () => {
    it('round-trips from, topic and any body, and refuses what it does not understand', () => {
        const from = newRelayReplicaId('7d1f0c2a-3b4e-4f5a-8c6d-9e0f1a2b3c4d');
        const body = 'a\u001fbody with the separator\nand newlines';
        expect(decodeRelayEnvelope(encodeRelayEnvelope(from, 'fleet-link.rpc', body))).toEqual({
            from,
            topic: 'fleet-link.rpc',
            body,
        });
        expect(decodeRelayEnvelope('2\u001fx\u001fy\u001fz')).toBeNull();
        expect(decodeRelayEnvelope(encodeRelayEnvelope('not-a-replica', 'a.b', ''))).toBeNull();
        expect(decodeRelayEnvelope(encodeRelayEnvelope(from, 'Bad Topic', ''))).toBeNull();
        expect(decodeRelayEnvelope(42)).toBeNull();
        expect(isRelayBusTopic('relay.terminal')).toBe(true);
        expect(isRelayBusTopic('__proto__')).toBe(false);
    });
});

describe('InProcessRelayBus', () => {
    it('has no peers, sends nothing, and holds a claim in this process', async () => {
        let now = 0;
        const bus = new InProcessRelayBus(() => now);
        expect(bus.publish()).toBe(false);
        expect(bus.peers()).toEqual([]);
        expect(bus.health()).toEqual({ configured: false, mode: 'single-replica', status: 'up' });
        expect(await bus.claimOnce('jti-1', 1_000)).toBe(true);
        expect(await bus.claimOnce('jti-1', 1_000)).toBe(false);
        now = 1_001;
        expect(await bus.claimOnce('jti-1', 1_000)).toBe(true);
    });
});

for (const backend of [fakeBackend, ...(REAL_URL ? [realBackend] : [])]) {
    describe(`ValkeyRelayBus — ${backend.name}`, () => {
        it('finds its peer, broadcasts to it and never to itself', async () => {
            const { a, b } = backend.make();
            await until(() => a.peers().includes(b.replicaId) && b.peers().includes(a.replicaId));
            const seenByA: string[] = [];
            const seenByB: Array<[string, string]> = [];
            a.subscribe('test.topic', (body) => seenByA.push(body));
            b.subscribe('test.topic', (body, from) => seenByB.push([body, from]));
            expect(a.publish('test.topic', 'hello')).toBe(true);
            await until(() => seenByB.length === 1);
            expect(seenByB).toEqual([['hello', a.replicaId]]);
            expect(seenByA).toEqual([]);
            expect(a.health()).toEqual({ configured: true, mode: 'valkey', status: 'up' });
        });

        it('delivers an addressed message to that replica only, and refuses a bad topic', async () => {
            const { a, b } = backend.make();
            await until(() => a.peers().includes(b.replicaId));
            const seen: string[] = [];
            b.subscribe('test.direct', (body) => seen.push(body));
            expect(a.sendTo(b.replicaId, 'test.direct', 'for b')).toBe(true);
            expect(a.sendTo(a.replicaId, 'test.direct', 'to myself')).toBe(false);
            expect(a.publish('Not A Topic', 'x')).toBe(false);
            expect(() => a.subscribe('Not A Topic', () => undefined)).toThrow();
            await until(() => seen.length === 1);
            expect(seen).toEqual(['for b']);
        });

        it('holds a claim fleet-wide: the second replica is refused', async () => {
            const { a, b } = backend.make();
            await until(() => a.health().status === 'up' && b.health().status === 'up');
            const key = `jti-${newRelayReplicaId('00000000-0000-4000-8000-000000000001')}-${Date.now()}`;
            expect(await a.claimOnce(key, 5_000)).toBe(true);
            expect(await b.claimOnce(key, 5_000)).toBe(false);
            expect(await a.claimOnce(key, 5_000)).toBe(false);
        });

        it('isolates a handler that throws', async () => {
            const { a, b } = backend.make();
            await until(() => a.peers().includes(b.replicaId));
            const seen: string[] = [];
            b.subscribe('test.throw', () => {
                throw new Error('handler bug');
            });
            b.subscribe('test.throw', (body) => seen.push(body));
            a.publish('test.throw', 'still delivered');
            await until(() => seen.length === 1);
        });

        it('tells its peers when it leaves', async () => {
            const { a, b } = backend.make();
            await until(() => b.peers().includes(a.replicaId));
            const changes: Array<[string, boolean]> = [];
            b.onPeerChange((replica, present) => changes.push([replica, present]));
            await a.close();
            await until(() => !b.peers().includes(a.replicaId));
            expect(changes).toContainEqual([a.replicaId, false]);
        });
    });
}

describe('ValkeyRelayBus — a lost connection', () => {
    it('reads degraded, drops what it cannot send, refuses a claim, and recovers', async () => {
        const { a, b, cut, restore } = fakeBackend.make();
        await until(() => a.peers().includes(b.replicaId));
        cut!();
        expect(a.health().status).toBe('degraded');
        expect(a.publish('test.topic', 'lost')).toBe(false);
        await expect(a.claimOnce('k', 1_000)).rejects.toThrow('not connected');
        restore!();
        expect(a.health().status).toBe('up');
        const seen: string[] = [];
        b.subscribe('test.topic', (body) => seen.push(body));
        a.publish('test.topic', 'back');
        await until(() => seen.length === 1);
    });

    it('logs a connection error at most once a minute and never the URL', async () => {
        const warn = jest
            .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
        const hub = new FakeValkey();
        const bus = new ValkeyRelayBus({
            url: 'redis://:hunter2-secret@valkey.internal:6379',
            createClient: () => hub.client(),
        });
        buses.push(bus);
        hub.cutAll();
        hub.cutAll();
        const lines = warn.mock.calls.map((call) => String(call[0]));
        expect(lines.filter((line) => line.includes('relay bus connection'))).toHaveLength(1);
        expect(lines.join('\n')).not.toContain('hunter2-secret');
        warn.mockRestore();
    });
});

describe('the default ioredis client', () => {
    it('is built lazily enough not to connect in a spec that never asks for Valkey', () => {
        // Construction with an unreachable URL must not throw synchronously;
        // the bus starts degraded and ioredis keeps retrying in the background.
        const bus = new ValkeyRelayBus({
            url: 'redis://127.0.0.1:1',
            createClient: (url) =>
                new Redis(url, {
                    lazyConnect: true,
                    enableOfflineQueue: false,
                    retryStrategy: () => null,
                }) as unknown as RelayRedisClient,
        });
        buses.push(bus);
        expect(bus.health().status).toBe('degraded');
    });
});
