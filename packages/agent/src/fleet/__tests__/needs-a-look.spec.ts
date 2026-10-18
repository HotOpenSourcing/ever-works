import { Logger } from '@nestjs/common';
import {
    FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import { NeedsALookService } from '../needs-a-look/needs-a-look.service';
import type { NeedsALookProducer } from '../needs-a-look/needs-a-look.producer';
import {
    CONSENT_MISSING_START_COMMAND,
    consentMissingItems,
} from '../needs-a-look/producers/consent-missing.producer';
import { diskLowItems } from '../needs-a-look/producers/disk-low.producer';
import { helperUntrustedItems } from '../needs-a-look/producers/helper-untrusted.producer';
import { nodeQuarantinedItems } from '../needs-a-look/producers/node-quarantined.producer';
import { nodeThrottledItems } from '../needs-a-look/producers/node-throttled.producer';

const GIB = 1024 ** 3;
const NOW = new Date('2026-10-18T09:41:00.000Z');
const CONTEXT = { now: NOW };

function node(overrides: Partial<FleetNodeView> & Record<string, unknown> = {}): FleetNodeView {
    return {
        id: 'n1',
        name: 'design-mac',
        kind: 'node',
        status: 'online',
        platform: 'darwin/arm64',
        version: '0.3.0',
        capabilities: ['claude-code'],
        lastHeartbeatAt: '2026-10-18T09:40:12.000Z',
        createdAt: '2026-10-01T00:00:00.000Z',
        persisted: true,
        ...overrides,
    } as FleetNodeView;
}

describe('NeedsALookService (seam owned by FL-01)', () => {
    const item = (id: string, severity: NeedsALookItem['severity'] = 'warn'): NeedsALookItem => ({
        id,
        nodeId: 'n1',
        nodeName: 'design-mac',
        severity,
        kind: 'disk-low',
        title: id,
        detail: null,
        since: '2026-10-18T09:00:00.000Z',
    });
    const producer = (id: string, produce: NeedsALookProducer['produce']): NeedsALookProducer => ({
        id,
        produce,
    });
    let warn: jest.SpyInstance;

    beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it('answers [] with no producers', async () => {
        expect(await new NeedsALookService().forNodes([node()])).toEqual({
            items: [],
            partial: false,
        });
    });

    it('merges every producer, sorted most severe first', async () => {
        const service = new NeedsALookService([
            producer('a', () => [item('x:warn')]),
            producer('b', async () => [item('y:critical', 'critical')]),
        ]);
        const result = await service.forNodes([node()]);
        expect(result.items.map((entry) => entry.id)).toEqual(['y:critical', 'x:warn']);
        expect(result.partial).toBe(false);
    });

    it('a throwing producer costs only its own items, is logged with its id, and marks the answer partial (U14)', async () => {
        const service = new NeedsALookService([
            producer('broken', () => {
                throw new Error('boom');
            }),
            producer('fine', () => [item('ok')]),
        ]);
        const result = await service.forNodes([node()]);
        expect(result.items.map((entry) => entry.id)).toEqual(['ok']);
        expect(result.partial).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
    });

    it('dedupes on the stable id — the first producer to claim it wins', async () => {
        const service = new NeedsALookService([
            producer('a', () => [{ ...item('same'), title: 'first' }]),
            producer('b', () => [{ ...item('same'), title: 'second' }]),
        ]);
        expect((await service.forNodes([node()])).items).toEqual([
            expect.objectContaining({ title: 'first' }),
        ]);
    });

    it('register adds a producer once per id', async () => {
        const service = new NeedsALookService();
        const late = producer('late', () => [item('late')]);
        service.register(late);
        service.register(late);
        expect(service.producerIds()).toEqual(['late']);
        expect((await service.forNodes([node()])).items).toHaveLength(1);
    });

    it('hands every producer the same "now"', async () => {
        const seen: Date[] = [];
        const service = new NeedsALookService([
            producer('a', (_nodes, context) => (seen.push(context.now), [])),
            producer('b', (_nodes, context) => (seen.push(context.now), [])),
        ]);
        await service.forNodes([node()], { now: NOW });
        expect(seen).toEqual([NOW, NOW]);
    });
});

describe('FL-03 producers — each fires exactly in its condition (ACC-FL03-05)', () => {
    describe('disk-low (FR-12, spec S5)', () => {
        const low = node({
            diskFreeBytes: 6 * GIB,
            minFreeDiskBytes: 5 * GIB,
            health: {
                at: '2026-10-18T09:40:12.000Z',
                diskPercent: 94,
                diskTotalMiB: 100 * 1024,
                diskLowSince: '2026-10-18T07:00:00.000Z',
            },
        });

        it('is critical within 1 GiB of the node’s own floor, in the spec’s words', () => {
            const [entry] = diskLowItems([low], CONTEXT);
            expect(entry).toMatchObject({
                id: 'disk-low:n1',
                severity: 'critical',
                kind: 'disk-low',
                title: 'Disk is 94% full · 6 GiB left, the node stops at 5 GiB',
                messageKey: 'diskLowCritical',
                params: { percent: 94, freeBytes: 6 * GIB, floorBytes: 5 * GIB },
                action: { label: 'Open', route: '/fleet/computers/n1?tab=overview' },
                // Stable: the instant the platform first saw the disk low.
                since: '2026-10-18T07:00:00.000Z',
            });
        });

        it('is a warning below 10% free, and nothing above it', () => {
            const warn = node({
                diskFreeBytes: 9 * GIB,
                minFreeDiskBytes: 5 * GIB,
                health: {
                    at: '2026-10-18T09:40:12.000Z',
                    diskPercent: 91,
                    diskTotalMiB: 100 * 1024,
                },
            });
            expect(diskLowItems([warn], CONTEXT)[0]).toMatchObject({
                severity: 'warn',
                title: 'Disk is 91% full · 9 GiB left',
                messageKey: 'diskLowWarn',
            });
            const fine = node({
                diskFreeBytes: 40 * GIB,
                minFreeDiskBytes: 5 * GIB,
                health: { at: 'x', diskTotalMiB: 100 * 1024 },
            });
            expect(diskLowItems([fine], CONTEXT)).toEqual([]);
        });

        it('with the floor switched off only the percentage rule applies — warn, never critical', () => {
            const noFloor = node({
                diskFreeBytes: 1 * GIB,
                minFreeDiskBytes: null,
                health: { at: 'x', diskTotalMiB: 100 * 1024 },
            });
            expect(diskLowItems([noFloor], CONTEXT)[0]?.severity).toBe('warn');
        });

        it('says only what is left when the node reported no percentage (an older node)', () => {
            const older = node({ diskFreeBytes: 6 * GIB, minFreeDiskBytes: 5 * GIB, health: null });
            expect(diskLowItems([older], CONTEXT)[0]).toMatchObject({
                severity: 'critical',
                title: '6 GiB left on the disk, the node stops at 5 GiB',
                params: { percent: null },
                // No marker without a snapshot: falls back to the last beat.
                since: '2026-10-18T09:40:12.000Z',
            });
        });

        it('skips offline computers (stale numbers), enrolling rows and live-merged cluster rows', () => {
            expect(diskLowItems([{ ...low, status: 'offline' }], CONTEXT)).toEqual([]);
            expect(diskLowItems([{ ...low, status: 'enrolling' }], CONTEXT)).toEqual([]);
            expect(diskLowItems([{ ...low, kind: 'k8s', persisted: false }], CONTEXT)).toEqual([]);
        });
    });

    describe('node-throttled (FR-13)', () => {
        const throttle = (provider: string, until: string) => ({
            provider,
            window: 'weekly' as const,
            until,
            reason: "You've hit your weekly limit",
            since: '2026-10-18T03:00:00.000Z',
        });

        it('limited: names the CLI and the reset, and clears exactly that CLI (spec S3)', () => {
            const limited = node({
                workerState: 'throttled',
                modelThrottles: [throttle('claude-code', '2026-10-19T01:00:00.000Z')],
            });
            expect(nodeThrottledItems([limited], CONTEXT)[0]).toMatchObject({
                id: 'node-throttled:n1',
                severity: 'warn',
                kind: 'node-throttled',
                title: "Waiting for Claude Code's limit to reset at Mon 19 Oct 01:00 UTC",
                detail: "You've hit your weekly limit",
                messageKey: 'limited',
                params: {
                    provider: 'claude-code',
                    cli: 'Claude Code',
                    until: '2026-10-19T01:00:00.000Z',
                    count: 1,
                },
                action: {
                    label: 'Clear limit now',
                    operation: { kind: 'clear-model-throttle', provider: 'claude-code' },
                },
                since: '2026-10-18T03:00:00.000Z',
            });
        });

        it('throttled: the dimension sentence of U13, with Change limits', () => {
            const throttled = node({
                workerState: 'throttled',
                workerStateReason: 'host CPU 92% is at or above the 85% ceiling',
                workerStateChangedAt: '2026-10-18T09:30:00.000Z',
                health: { at: 'x', cpuPercent: 92.2 },
                effectiveLimits: { maxConcurrentJobs: 1, maxCpuPercent: 85, maxMemoryMb: null },
            });
            expect(nodeThrottledItems([throttled], CONTEXT)[0]).toMatchObject({
                title: 'Pausing new work — CPU is above its ceiling (92% of 85%)',
                messageKey: 'throttledCpu',
                params: { dimension: 'cpu', value: 92, limit: 85 },
                action: { label: 'Change limits', route: '/fleet/computers/n1?tab=settings' },
                since: '2026-10-18T09:30:00.000Z',
            });
        });

        it('fires for nothing else: an online, busy, quarantined or offline computer', () => {
            expect(
                nodeThrottledItems(
                    [
                        node(),
                        node({ workerState: 'working' }),
                        node({ workerState: 'quarantined' }),
                    ],
                    CONTEXT,
                ),
            ).toEqual([]);
            expect(
                nodeThrottledItems(
                    [node({ status: 'offline', workerState: 'throttled' })],
                    CONTEXT,
                ),
            ).toEqual([]);
        });
    });

    describe('node-quarantined (FR-14, spec S4)', () => {
        it('is critical, carries the node’s reason, and offers the exact command — never a button', () => {
            const quarantined = node({
                workerState: 'quarantined',
                workerStateReason: 'process tree unproven',
                workerStateChangedAt: '2026-10-18T03:14:00.000Z',
            });
            const [entry] = nodeQuarantinedItems([quarantined], CONTEXT);
            expect(entry).toMatchObject({
                id: 'node-quarantined:n1',
                severity: 'critical',
                title: 'design-mac stopped itself: process tree unproven',
                action: { label: 'Show command', command: FLEET_NODE_CLEAR_QUARANTINE_COMMAND },
                since: '2026-10-18T03:14:00.000Z',
            });
            expect(entry.action).not.toHaveProperty('operation');
            expect(entry.action).not.toHaveProperty('route');
        });

        it('fires only for a quarantined, reachable computer', () => {
            expect(
                nodeQuarantinedItems([node(), node({ workerState: 'throttled' })], CONTEXT),
            ).toEqual([]);
            expect(
                nodeQuarantinedItems(
                    [node({ status: 'offline', workerState: 'quarantined' })],
                    CONTEXT,
                ),
            ).toEqual([]);
        });
    });

    describe('consent-missing (FR-15, spec S10)', () => {
        it('is info, with the start command, when every consent is reported off', () => {
            const enrolOnly = node({
                name: 'win-lab',
                consents: { work: false, attend: false, manage: false, usageScan: false },
            });
            expect(consentMissingItems([enrolOnly], CONTEXT)[0]).toMatchObject({
                id: 'consent-missing:n1',
                severity: 'info',
                title: 'win-lab only reports health. Start it with --work, --attend or --manage to do more.',
                action: { command: CONSENT_MISSING_START_COMMAND },
                since: '2026-10-01T00:00:00.000Z',
            });
        });

        it('is silent with any consent on, and while consents are not reported at all (never inferred)', () => {
            expect(
                consentMissingItems(
                    [node({ consents: { work: true, attend: false, manage: false } })],
                    CONTEXT,
                ),
            ).toEqual([]);
            expect(
                consentMissingItems(
                    [node({ consents: { work: false, attend: false, manage: true } })],
                    CONTEXT,
                ),
            ).toEqual([]);
            expect(consentMissingItems([node()], CONTEXT)).toEqual([]);
            expect(consentMissingItems([node({ consents: { work: false } })], CONTEXT)).toEqual([]);
        });
    });

    describe('helper-untrusted (FR-16)', () => {
        it('is a warning for a hash-pinned helper', () => {
            expect(
                helperUntrustedItems([node({ helperTrust: 'hash-pinned' })], CONTEXT)[0],
            ).toMatchObject({
                id: 'helper-untrusted:n1',
                severity: 'warn',
                title: "design-mac's screen helper runs with reduced trust",
                action: { route: '/fleet/computers/n1?tab=overview' },
            });
        });

        it('produces NOTHING while the field is absent — every row until FL-07 reports it — or not hash-pinned', () => {
            expect(helperUntrustedItems([node()], CONTEXT)).toEqual([]);
            expect(
                helperUntrustedItems(
                    [node({ helperTrust: 'signed' }), node({ helperTrust: 'none' })],
                    CONTEXT,
                ),
            ).toEqual([]);
        });
    });

    it('every producer gives the same id and since on a second render of the same condition (FR-17)', () => {
        const nodes = [
            node({ id: 'a', diskFreeBytes: 6 * GIB, minFreeDiskBytes: 5 * GIB }),
            node({
                id: 'b',
                workerState: 'quarantined',
                workerStateChangedAt: '2026-10-18T03:14:00.000Z',
            }),
        ];
        const later = { now: new Date(NOW.getTime() + 5 * 60_000) };
        const render = (context: { now: Date }) =>
            [...diskLowItems(nodes, context), ...nodeQuarantinedItems(nodes, context)].map(
                (entry) => [entry.id, entry.since],
            );
        expect(render(later)).toEqual(render(CONTEXT));
    });
});
