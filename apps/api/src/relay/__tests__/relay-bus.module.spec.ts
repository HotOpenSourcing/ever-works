import { encodeTerminalFrame, type TerminalFrame } from '@ever-works/contracts';
import { ComputerRelayRegistry } from '../../computer/computer-relay.registry';
import { TerminalRelayRegistry } from '../../terminal/terminal-relay.registry';
import { createRelayBus, RELAY_BUS_REQUIRED_MESSAGE } from '../relay-bus.module';
import { InProcessRelayBus } from '../relay-bus.in-process';
import { ValkeyRelayBus } from '../relay-bus.valkey';
import { RelayComputerFanoutBus, RelayTerminalFanoutBus } from '../relay-fanout';
import { FakeValkey, flushBus, TEST_RELAY_SECRET } from './relay-test-kit';

/**
 * Relay bus selection (CONTRACTS R-7, spec FR-29 … FR-31) and the terminal
 * and computer relays riding it: Valkey exactly when a Redis URL is set,
 * in-process otherwise, a boot error naming `FLEET_RELAY_REQUIRE_BUS` when a
 * required bus is missing — and a frame published on one replica reaching a
 * browser attached to the other.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await flushBus(2);
    }
}

describe('createRelayBus', () => {
    it('runs in-process without a Redis URL', () => {
        const bus = createRelayBus({ url: null, required: false });
        expect(bus).toBeInstanceOf(InProcessRelayBus);
        expect(bus.health()).toEqual({ configured: false, mode: 'single-replica', status: 'up' });
    });

    it('runs on Valkey whenever a Redis URL is set — no other setting chooses', async () => {
        const hub = new FakeValkey();
        const bus = createRelayBus({
            url: 'redis://valkey:6379',
            required: false,
            valkey: { createClient: () => hub.client() },
        });
        closers.push(() => bus.close());
        expect(bus).toBeInstanceOf(ValkeyRelayBus);
        expect(bus.mode).toBe('valkey');
        expect(bus.health()).toMatchObject({ configured: true, mode: 'valkey' });
    });

    it('fails boot with a message naming FLEET_RELAY_REQUIRE_BUS when a required bus is missing', () => {
        expect(() => createRelayBus({ url: null, required: true })).toThrow(
            RELAY_BUS_REQUIRED_MESSAGE,
        );
        expect(RELAY_BUS_REQUIRED_MESSAGE).toContain('FLEET_RELAY_REQUIRE_BUS');
        expect(RELAY_BUS_REQUIRED_MESSAGE).toContain('REDIS_URL');
    });
});

function twoReplicas() {
    const hub = new FakeValkey();
    const a = new ValkeyRelayBus({
        secret: TEST_RELAY_SECRET,
        url: 'redis://fake',
        createClient: () => hub.client(),
    });
    const b = new ValkeyRelayBus({
        secret: TEST_RELAY_SECRET,
        url: 'redis://fake',
        createClient: () => hub.client(),
    });
    closers.push(
        () => a.close(),
        () => b.close(),
    );
    return { hub, a, b };
}

describe('the terminal relay over the bus', () => {
    it('fans a frame published on replica A out to a browser attached on replica B', async () => {
        const { a, b } = twoReplicas();
        await until(() => a.peers().length === 1 && b.peers().length === 1);
        const onA = new TerminalRelayRegistry(new RelayTerminalFanoutBus(a));
        const onB = new TerminalRelayRegistry(new RelayTerminalFanoutBus(b));
        const received: string[] = [];
        onB.attach('run-1', { id: 'browser', role: 'driver', send: (wire) => received.push(wire) });
        const frame: TerminalFrame = {
            kind: 'stdout',
            seq: 0,
            data: Buffer.from('hi').toString('base64'),
        };
        expect(onA.publish('run-1', frame)).toBe(true);
        await until(() => received.some((wire) => wire === encodeTerminalFrame(frame)));
    });

    it('sends nothing with the single-replica bus', () => {
        const bus = new InProcessRelayBus();
        const publish = jest.spyOn(bus, 'publish');
        const registry = new TerminalRelayRegistry(new RelayTerminalFanoutBus(bus));
        registry.publish('run-1', { kind: 'stdout', seq: 0, data: '' });
        expect(publish).toHaveBeenCalled();
        expect(publish.mock.results.every((result) => result.value === false)).toBe(true);
    });
});

describe('the computer relay over the bus', () => {
    it('answers "a peer may have it" only when another replica is there', async () => {
        const { a, b } = twoReplicas();
        const busA = new RelayComputerFanoutBus(a);
        const seen: Array<[string, string]> = [];
        new RelayComputerFanoutBus(b).onRemote((sessionId, wire) => seen.push([sessionId, wire]));
        expect(busA.publishRemote('view-1', 'lost')).toBe(false); // nobody heard yet: nothing sent
        await until(() => a.peers().length === 1);
        expect(busA.publishRemote('view-2', 'wire')).toBe(true);
        await until(() => seen.length === 1);
        await flushBus();
        expect(seen).toEqual([['view-2', 'wire']]);
        // The real registry accepts the seam's shape.
        expect(new ComputerRelayRegistry(busA)).toBeInstanceOf(ComputerRelayRegistry);
    });

    it('ignores a message that is not a [key, wire] pair', async () => {
        const { a, b } = twoReplicas();
        await until(() => a.peers().length === 1);
        const seen: unknown[] = [];
        new RelayComputerFanoutBus(b).onRemote((...args) => seen.push(args));
        a.publish('relay.computer', '{"not":"a pair"}');
        a.publish('relay.computer', JSON.stringify(['', 'empty key']));
        a.publish('relay.computer', JSON.stringify(['ok', 'wire']));
        await until(() => seen.length === 1);
        expect(seen).toEqual([['ok', 'wire']]);
    });
});
