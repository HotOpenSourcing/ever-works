import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetJobService, FleetNodeHealthService, FleetService } from '@ever-works/agent/fleet';
import {
    isFleetNodeHealthStale,
    resolveComputerState,
    type ComputerStateResolution,
    type FleetNodeHealthStored,
    type FleetNodeView,
} from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

/** `GET /api/fleet/nodes/:id/health` — the computer's health, as every surface reads it. */
export interface FleetNodeHealthResponse {
    nodeId: string;
    /** The latest snapshot, stamped with the platform's receipt time; null = this node version reports none. */
    snapshot: FleetNodeHealthStored | null;
    /** True when the snapshot is older than the offline threshold — shown dimmed, never as current (FR-5, FR-30). */
    stale: boolean;
    /** The plain-language state and its one fix (FR-7, FR-8). */
    state: ComputerStateResolution;
    /** Whether this deployment keeps health history (`FLEET_HEALTH_HISTORY_ENABLED`). */
    historyEnabled: boolean;
}

/**
 * Computer health (FL-03) — the read side of a computer's health.
 *
 * `GET /api/fleet/nodes/:id/health` answers the snapshot the row holds (one
 * read, no history join), whether it is stale, and the computer's state
 * sentence with its fix — computed by `resolveComputerState`, the same pure
 * function the cards, the header and the Agent tool use, so no two surfaces
 * can disagree about what state a machine is in.
 *
 * Family: `view` (CONTRACTS §2.1). Until FL-01's role derivation lands every
 * fleet read is owner-scoped, and another account's node id answers 404,
 * exactly like an unknown one. Reads are not audited (§2.3).
 *
 * Refresh now (`POST`), the history and wake arrive in FL-03's next phase on
 * FL-02's link.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
export class FleetHealthController {
    constructor(
        private readonly service: FleetService,
        private readonly jobs: FleetJobService,
        private readonly history: FleetNodeHealthService,
    ) {}

    @Get('nodes/:id/health')
    @ApiOperation({
        summary:
            "One computer's health: the latest snapshot (CPU, memory, disk, load, uptime, GPU, pending reboot, failed services) stamped with the platform's receipt time, whether it is stale, and its plain-language state with its one fix. Owner-scoped: another account's node id answers 404.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async health(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetNodeHealthResponse> {
        // Ownership first: a 404 here means nothing else is read.
        const node = await this.service.getForUser(auth.userId, id);
        const withLoad = await this.withLoad(auth.userId, node);
        const now = Date.now();
        const snapshot = node.health ?? null;
        return {
            nodeId: node.id,
            snapshot,
            stale: isFleetNodeHealthStale(snapshot, now, offlineThresholdMs()),
            state: resolveComputerState(withLoad, { now }),
            historyEnabled: this.history.isHistoryEnabled(),
        };
    }

    /** The job count behind "Busy · 2 jobs" — best-effort, like the node list. */
    private async withLoad(userId: string, node: FleetNodeView): Promise<FleetNodeView> {
        try {
            const load = await this.jobs.loadByNodeForUser(userId);
            return { ...node, load: load[node.id] ?? null };
        } catch {
            return node;
        }
    }
}

/** The silence after which a node sweeps offline — the same threshold staleness is judged by. */
export function offlineThresholdMs(): number {
    return config.fleet.getNodeOfflineAfterMs();
}
