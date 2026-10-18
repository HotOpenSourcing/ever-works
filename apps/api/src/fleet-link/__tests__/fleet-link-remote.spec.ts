import type { FleetLinkChannelOpen, FleetLinkRequest } from '@ever-works/contracts';
import { asFleetLinkRequest } from '@ever-works/contracts';
import { ValkeyRelayBus } from '../../relay/relay-bus.valkey';
import { FakeValkey, flushBus } from '../../relay/__tests__/relay-test-kit';
import { FleetLinkRegistry } from '../fleet-link.registry';
import { FleetLinkRemote } from '../fleet-link-remote.service';
import { FleetOperationsService } from '../fleet-operations.service';
import type { FleetLinkRequirement } from '../fleet-link.types';
import { controlFrame, hello, jsonFrame, NODE_ID, OWNER, RecordingPort } from './link-test-kit';

/**
 * The node link across API replicas (FL-02 P1b, CONTRACTS R-7, spec S7): the
 * directory, forwarded requests and channels (frames both ways, close,
 * resume), one link per node fleet-wide, consents / drain / gone fanned out,
 * operation records shared, and a replica that goes away.
 */

const LOGS: FleetLinkRequirement = {
    consent: 'manage',
    actionFamily: 'logs',
    stateChanging: false,
};

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await flushBus(2);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

function replica(hub: FakeValkey) {
    const bus = new ValkeyRelayBus({ url: 'redis://fake', createClient: () => hub.client() });
    const registry = new FleetLinkRegistry();
    const remote = new FleetLinkRemote(registry, bus);
    const operations = new FleetOperationsService(registry, undefined, remote);
    closers.push(
        () => bus.close(),
        () => remote.onModuleDestroy(),
        () => operations.onModuleDestroy(),
    );
    return { bus, registry, remote, operations };
}

async function twoReplicas() {
    const hub = new FakeValkey();
    const a = replica(hub);
    const b = replica(hub);
    await until(() => a.bus.peers().length === 1 && b.bus.peers().length === 1);
    return { hub, a, b };
}

/** A node linked to `side`, answering channel opens and requests like the real client would. */
function linkNode(
    side: ReturnType<typeof replica>,
    consents = { work: true, attend: false, manage: true, usageScan: false },
) {
    const port = new RecordingPort();
    const session = side.registry.accept({
        nodeId: NODE_ID,
        ownerUserId: OWNER,
        nodeName: 'build-01',
        nodeKind: 'node',
        hello: hello({ consents }),
        socket: port,
    });
    const openSeen = new Set<string>();
    const answerOpens = () => {
        for (const message of port.controls()) {
            if (message.type !== 'channel.open') continue;
            const open = message as FleetLinkChannelOpen;
            if (openSeen.has(open.requestId)) continue;
            openSeen.add(open.requestId);
            session.receive(
                controlFrame({
                    type: 'channel.ready',
                    channel: open.channel,
                    requestId: open.requestId,
                }),
            );
        }
    };
    const requestsOn = (channel: number): FleetLinkRequest[] =>
        port
            .jsonOn(channel)
            .map((message) => asFleetLinkRequest(message))
            .filter((request): request is FleetLinkRequest => request !== null);
    return { port, session, answerOpens, requestsOn };
}

describe('FleetLinkRemote — the directory', () => {
    it('tells every replica which one holds a node’s link, and forgets it when the link closes', async () => {
        const { a, b } = await twoReplicas();
        const events: string[] = [];
        b.remote.onLinkEvent((event) => events.push(event.type));
        const node = linkNode(a);
        await until(() => b.remote.holderOf(NODE_ID) === a.bus.replicaId);
        expect(a.remote.holderOf(NODE_ID)).toBeNull(); // held here
        expect(b.remote.linkView(NODE_ID)).toMatchObject({ state: 'connected', linkGeneration: 1 });
        expect(b.remote.liveConsents(NODE_ID)).toMatchObject({ manage: true });
        node.session.dropped('closed 1006');
        await until(() => b.remote.holderOf(NODE_ID) === null);
        expect(events).toEqual(['connected', 'dropped']);
    });

    it('forgets every link of a replica that leaves', async () => {
        const { a, b } = await twoReplicas();
        linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        await a.bus.close();
        await until(() => !b.remote.isHeldElsewhere(NODE_ID));
    });

    it('keeps one link per node fleet-wide: a newer link on another replica replaces the older', async () => {
        const { a, b } = await twoReplicas();
        const older = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        await new Promise((resolve) => setTimeout(resolve, 5)); // a later connectedAt
        linkNode(b);
        await until(() => older.port.closed !== null);
        expect(older.port.closed?.code).toBe(4010);
        await until(() => a.remote.holderOf(NODE_ID) === b.bus.replicaId);
    });

    it('learns the links a replica already holds when it joins late', async () => {
        const hub = new FakeValkey();
        const a = replica(hub);
        linkNode(a);
        const b = replica(hub);
        await until(() => b.remote.holderOf(NODE_ID) === a.bus.replicaId);
    });
});

describe('FleetLinkRemote — forwarding', () => {
    it('answers a machine request on the replica that holds the link', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const reply = b.remote.request({
            nodeId: NODE_ID,
            verb: 'health.now',
            params: {},
            requestedBy: `user:${OWNER}`,
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        await until(() => node.requestsOn(open.channel).length === 1);
        const [request] = node.requestsOn(open.channel);
        expect(request.type).toBe('health.now');
        node.session.receive(
            jsonFrame(open.channel, { requestId: request.requestId, result: { cpu: 3 } }),
        );
        await expect(reply).resolves.toEqual({ requestId: request.requestId, result: { cpu: 3 } });
    });

    it('carries a channel both ways — open, frames, requests, close — and holds early frames until it is open', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const seen: unknown[] = [];
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: { source: 'journal' },
            requirement: LOGS,
            requestedBy: `user:${OWNER}`,
            events: {
                json: (message) => seen.push(['json', message]),
                binary: (kind, payload) => seen.push(['bin', kind, [...payload]]),
                close: (reason) => seen.push(['close', reason]),
            },
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        expect(open).toMatchObject({ family: 'logs', params: { source: 'journal' } });
        // The node answers ready and writes at once — before B has the answer.
        node.answerOpens();
        node.session.receive(jsonFrame(open.channel, { type: 'logs.initial-done' }));
        const channel = await opening;
        expect(channel.isOpen).toBe(true);
        expect(channel.channel).toBe(open.channel);
        await until(() => seen.length === 1);
        expect(seen[0]).toEqual(['json', { type: 'logs.initial-done' }]);

        expect(channel.sendJson({ type: 'logs.pause' })).toBe(true);
        await until(() => node.port.jsonOn(open.channel).some((m) => m.type === 'logs.pause'));
        channel.sendBinary(30, new Uint8Array([0, 0, 16, 0]));
        await until(() =>
            node.port.frames.some((f) => f.channel === open.channel && f.kind === 30),
        );

        const asked = channel.request('logs.earlier', { lines: 10 });
        await until(() => node.requestsOn(open.channel).some((r) => r.type === 'logs.earlier'));
        const request = node.requestsOn(open.channel).find((r) => r.type === 'logs.earlier')!;
        node.session.receive(
            jsonFrame(open.channel, { requestId: request.requestId, result: ['a'] }),
        );
        await expect(asked).resolves.toMatchObject({ result: ['a'] });

        node.session.receive(
            controlFrame({ type: 'channel.close', channel: open.channel, reason: 'normal' }),
        );
        await until(() => channel.isClosed);
        expect(seen.at(-1)).toEqual(['close', 'normal']);
    });

    it('closes a channel on the holder that the caller no longer knows (it gave up waiting)', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const channel = (await opening) as unknown as { ref?: string };
        // B forgets the channel (as when its open timed out); the node keeps writing.
        (b.remote as unknown as { opened: Map<string, unknown> }).opened.clear();
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        node.session.receive(jsonFrame(open.channel, { type: 'logs.line', text: 'hello' }));
        await until(() =>
            node.port
                .controls()
                .some(
                    (m) =>
                        m.type === 'channel.close' &&
                        (m as { channel: number }).channel === open.channel,
                ),
        );
        expect(channel).toBeDefined();
    });

    it('closes the node’s side when the caller closes', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const channel = await opening;
        channel.close();
        await until(() => node.port.controls().some((m) => m.type === 'channel.close'));
    });

    it('carries the node’s refusal back as the same typed error', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        const open = node.port.last('channel.open') as FleetLinkChannelOpen;
        node.session.receive(
            controlFrame({
                type: 'channel.refused',
                channel: open.channel,
                requestId: open.requestId,
                error: {
                    code: 'consent_missing',
                    hint: 'start the node with --manage on build-01',
                },
            }),
        );
        await expect(opening).rejects.toMatchObject({
            linkError: {
                code: 'consent_missing',
                hint: 'start the node with --manage on build-01',
            },
        });
    });

    it('answers unreachable when the holder goes away mid-call, and ends its channels', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = b.remote.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            params: {},
            requirement: LOGS,
            requestedBy: 'x',
        });
        await until(() => node.port.controls().some((m) => m.type === 'channel.open'));
        node.answerOpens();
        const channel = await opening;
        const pending = b.remote.request({
            nodeId: NODE_ID,
            verb: 'health.now',
            params: {},
            requestedBy: 'x',
        });
        const reasons: string[] = [];
        channel.listen({ close: (reason) => reasons.push(reason) });
        await a.bus.close();
        await expect(pending).rejects.toMatchObject({ linkError: { code: 'unreachable' } });
        await until(() => channel.isClosed);
        expect(reasons).toEqual(['resume_failed']);
    });
});

describe('FleetLinkRemote — fan-out', () => {
    it('hands a heartbeat’s withdrawn consent to the holder, which closes the channels that needed it', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        const opening = a.registry.openChannel({
            nodeId: NODE_ID,
            family: 'logs',
            requirement: LOGS,
            requestedBy: 'x',
        });
        node.answerOpens();
        const logs = await opening;
        b.remote.forwardConsents(NODE_ID, {
            work: true,
            attend: false,
            manage: false,
            usageScan: false,
        });
        await until(() => logs.isClosed);
        expect(node.port.last('channel.close')).toMatchObject({ reason: 'consent_missing' });
    });

    it('drains and closes a gone node on whichever replica holds its link', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        b.remote.broadcastDrain([NODE_ID], 60);
        await until(() => node.port.controls().some((m) => m.type === 'link.drain'));
        b.remote.broadcastGone(NODE_ID, 'node removed');
        await until(() => node.port.closed !== null);
        expect(node.port.closed?.code).toBe(4001);
    });
});

describe('FleetLinkRemote — operation records', () => {
    it('shares a record: tracked on B, finished by the node on A, read done on both', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        // The node reports progress to A before B's record arrives there.
        node.session.receive(
            controlFrame({
                type: 'operation.progress',
                operationId: 'op-1',
                progress: { percent: 10 },
            }),
        );
        b.operations.track({
            operationId: 'op-1',
            nodeId: NODE_ID,
            family: 'machine',
            verb: 'docker.image.pull',
            requesterUserId: OWNER,
            ownerUserId: OWNER,
        });
        await until(() => a.operations.size === 1);
        await until(() => b.operations.get('op-1', OWNER).progress?.percent === 10);
        node.session.receive(
            controlFrame({ type: 'operation.done', operationId: 'op-1', result: { ok: 1 } }),
        );
        await until(() => b.operations.get('op-1', OWNER).state === 'done');
        expect(a.operations.get('op-1', OWNER)).toMatchObject({ state: 'done', result: { ok: 1 } });
    });

    it('cancels through the holder: the node is told, and both read cancelled', async () => {
        const { a, b } = await twoReplicas();
        const node = linkNode(a);
        await until(() => b.remote.isHeldElsewhere(NODE_ID));
        b.operations.track({
            operationId: 'op-2',
            nodeId: NODE_ID,
            family: 'machine',
            verb: 'compose.up',
            requesterUserId: OWNER,
            ownerUserId: OWNER,
        });
        await until(() => a.operations.size === 1);
        await expect(b.operations.requestCancel('op-2', OWNER)).resolves.toMatchObject({
            sent: true,
        });
        expect(node.port.last('operation.cancel')).toEqual({
            type: 'operation.cancel',
            operationId: 'op-2',
        });
        node.session.receive(
            controlFrame({
                type: 'operation.done',
                operationId: 'op-2',
                error: { code: 'operation_failed', hint: 'cancelled' },
            }),
        );
        await until(() => b.operations.get('op-2', OWNER).state === 'cancelled');
        expect(a.operations.get('op-2', OWNER).state).toBe('cancelled');
    });
});
