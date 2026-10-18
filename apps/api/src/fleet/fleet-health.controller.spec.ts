import 'reflect-metadata';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type {
    FleetJobService,
    FleetNodeHealthService,
    FleetService,
} from '@ever-works/agent/fleet';
import type { FleetNodeView } from '@ever-works/contracts';
import { FleetHealthController } from './fleet-health.controller';
import {
    FleetNeedsALookController,
    NEEDS_A_LOOK_PARTIAL_HEADER,
} from './fleet-needs-a-look.controller';

const USER = { userId: 'user-1' } as never;
const NODE_ID = '11111111-1111-4111-8111-111111111111';

function view(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: NODE_ID,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.3.0',
        capabilities: ['claude-code'],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: '2026-10-01T00:00:00.000Z',
        persisted: true,
        health: null,
        ...overrides,
    };
}

/**
 * Computer health (FL-03) — the read routes: `GET /api/fleet/nodes/:id/health`
 * and the needs-a-look list (seam owned by FL-01). Both are owner-scoped until
 * FL-01's role derivation lands: a foreign node id is a 404, exactly like an
 * unknown one, and nothing else is read for it.
 */
describe('FleetHealthController — GET /api/fleet/nodes/:id/health', () => {
    let service: { getForUser: jest.Mock };
    let jobs: { loadByNodeForUser: jest.Mock };
    let history: { isHistoryEnabled: jest.Mock };
    let controller: FleetHealthController;

    beforeEach(() => {
        service = { getForUser: jest.fn(async () => view()) };
        jobs = { loadByNodeForUser: jest.fn(async () => ({})) };
        history = { isHistoryEnabled: jest.fn(() => false) };
        controller = new FleetHealthController(
            service as unknown as FleetService,
            jobs as unknown as FleetJobService,
            history as unknown as FleetNodeHealthService,
        );
    });

    it('is mounted where CONTRACTS §11.2 puts it', () => {
        expect(Reflect.getMetadata(PATH_METADATA, FleetHealthController)).toBe('api/fleet');
        expect(Reflect.getMetadata(PATH_METADATA, FleetHealthController.prototype.health)).toBe(
            'nodes/:id/health',
        );
        expect(Reflect.getMetadata(METHOD_METADATA, FleetHealthController.prototype.health)).toBe(
            RequestMethod.GET,
        );
    });

    it('answers the stored snapshot, fresh, with the computer’s state', async () => {
        const at = new Date(Date.now() - 48_000).toISOString();
        service.getForUser.mockResolvedValue(
            view({ health: { at, cpuPercent: 31, memPercent: 58 } }),
        );
        history.isHistoryEnabled.mockReturnValue(true);
        expect(await controller.health(USER, NODE_ID)).toEqual({
            nodeId: NODE_ID,
            snapshot: { at, cpuPercent: 31, memPercent: 58 },
            stale: false,
            state: { state: 'online', params: {}, action: null },
            historyEnabled: true,
        });
    });

    it('marks a 2 h-old snapshot stale and a node without one as "no snapshot" (ACC-FL03-02)', async () => {
        const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
        service.getForUser.mockResolvedValue(view({ health: { at: old, cpuPercent: 3 } }));
        expect((await controller.health(USER, NODE_ID)).stale).toBe(true);
        service.getForUser.mockResolvedValue(view({ health: null }));
        const none = await controller.health(USER, NODE_ID);
        expect(none.snapshot).toBeNull();
        expect(none.stale).toBe(true);
    });

    it('composes the job count so the state can say "Busy · 2 jobs", and degrades without it', async () => {
        jobs.loadByNodeForUser.mockResolvedValue({
            [NODE_ID]: { activeJobCount: 2, currentJobKind: 'agent-task', currentJobId: 'j' },
        });
        expect((await controller.health(USER, NODE_ID)).state).toEqual({
            state: 'busy',
            params: { jobs: 2 },
            action: null,
        });
        jobs.loadByNodeForUser.mockRejectedValue(new Error('job runtime down'));
        expect((await controller.health(USER, NODE_ID)).state.state).toBe('online');
    });

    it('a stranger’s node id is a 404 and nothing else is read', async () => {
        service.getForUser.mockRejectedValue(new NotFoundException('Fleet node not found'));
        await expect(controller.health(USER, NODE_ID)).rejects.toBeInstanceOf(NotFoundException);
        expect(jobs.loadByNodeForUser).not.toHaveBeenCalled();
    });
});

describe('FleetNeedsALookController (seam owned by FL-01)', () => {
    let service: { listForUser: jest.Mock; getForUser: jest.Mock };
    let jobs: { loadByNodeForUser: jest.Mock };
    let needsALook: { forNodes: jest.Mock };
    let response: { setHeader: jest.Mock };
    let controller: FleetNeedsALookController;

    beforeEach(() => {
        service = {
            listForUser: jest.fn(async () => [view()]),
            getForUser: jest.fn(async () => view()),
        };
        jobs = { loadByNodeForUser: jest.fn(async () => ({})) };
        needsALook = { forNodes: jest.fn(async () => ({ items: [], partial: false })) };
        response = { setHeader: jest.fn() };
        controller = new FleetNeedsALookController(
            service as unknown as FleetService,
            jobs as unknown as FleetJobService,
            needsALook as never,
        );
    });

    it('is mounted at the two CONTRACTS §11.2 paths', () => {
        expect(Reflect.getMetadata(PATH_METADATA, FleetNeedsALookController.prototype.list)).toBe(
            'needs-a-look',
        );
        expect(
            Reflect.getMetadata(PATH_METADATA, FleetNeedsALookController.prototype.forNode),
        ).toBe('nodes/:id/needs-a-look');
    });

    it('answers [] with nothing to report, and no partial header', async () => {
        expect(await controller.list(USER, response)).toEqual([]);
        expect(response.setHeader).not.toHaveBeenCalled();
    });

    it('hands the producers every visible computer once, with its job count', async () => {
        jobs.loadByNodeForUser.mockResolvedValue({
            [NODE_ID]: { activeJobCount: 1, currentJobKind: 'agent-task', currentJobId: 'j' },
        });
        await controller.list(USER, response);
        const [nodes] = needsALook.forNodes.mock.calls[0];
        expect(nodes).toHaveLength(1);
        expect(nodes[0].load).toMatchObject({ activeJobCount: 1 });
    });

    it('flags a partial answer when a producer failed (U14)', async () => {
        needsALook.forNodes.mockResolvedValue({ items: [], partial: true });
        await controller.list(USER, response);
        expect(response.setHeader).toHaveBeenCalledWith(NEEDS_A_LOOK_PARTIAL_HEADER, 'true');
    });

    it('a stranger’s node id is a 404 and no producer ever sees it', async () => {
        service.getForUser.mockRejectedValue(new NotFoundException('Fleet node not found'));
        await expect(controller.forNode(USER, NODE_ID, response)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(needsALook.forNodes).not.toHaveBeenCalled();
    });
});
