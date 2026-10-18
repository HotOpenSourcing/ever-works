import {
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FleetJobService, FleetService, NeedsALookService } from '@ever-works/agent/fleet';
import type { FleetNodeView, NeedsALookItem } from '@ever-works/contracts';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FleetEnabledGuard } from './guards/fleet-enabled.guard';

/** The one response capability these routes use (the auth controllers type `@Res()` the same way). */
type HeaderResponse = { setHeader(name: string, value: string | string[]): void };

/** Set when a producer failed and its items are missing from the answer (spec U14). */
export const NEEDS_A_LOOK_PARTIAL_HEADER = 'X-Fleet-Needs-A-Look-Partial';

/**
 * Fleet "needs a look" (CONTRACTS §4.6, §11.2) — the list the hub renders.
 *
 * Seam owned by FL-01 (its P1 T-06), built by FL-03 so its five producers
 * have a reader: the same two routes, owner-scoped as FL-01's P1 states.
 * FL-01 widens visibility with its role derivation (P2) HERE rather than
 * adding the routes a second time — two controllers declaring one path is a
 * silent first-wins in Express.
 *
 * Every computer is read once (one row per computer, plus the job counts the
 * node list already composes) and handed to every producer once. A producer
 * that throws is logged and skipped; the answer then carries
 * {@link NEEDS_A_LOOK_PARTIAL_HEADER} so a surface can say "some checks could
 * not run" instead of implying the list is complete.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard)
export class FleetNeedsALookController {
    constructor(
        private readonly service: FleetService,
        private readonly jobs: FleetJobService,
        private readonly needsALook: NeedsALookService,
    ) {}

    @Get('needs-a-look')
    @ApiOperation({
        summary:
            'Everything on my computers that wants a look — disk running low, a throttled or quarantined node, a computer that gave no consent beyond enrolment, a reduced-trust screen helper — most severe first, each with at most one action.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Res({ passthrough: true }) response: HeaderResponse,
    ): Promise<NeedsALookItem[]> {
        const nodes = await this.withLoad(auth.userId, await this.service.listForUser(auth.userId));
        return this.answer(nodes, response);
    }

    @Get('nodes/:id/needs-a-look')
    @ApiOperation({
        summary:
            "What wants a look on one computer. Owner-scoped: another account's node id answers 404, exactly like an unknown one.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async forNode(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) response: HeaderResponse,
    ): Promise<NeedsALookItem[]> {
        // Ownership first: a 404 here means no producer ever sees the node.
        const node = await this.service.getForUser(auth.userId, id);
        return this.answer(await this.withLoad(auth.userId, [node]), response);
    }

    private async answer(
        nodes: FleetNodeView[],
        response: HeaderResponse,
    ): Promise<NeedsALookItem[]> {
        const result = await this.needsALook.forNodes(nodes);
        if (result.partial) response.setHeader(NEEDS_A_LOOK_PARTIAL_HEADER, 'true');
        return result.items;
    }

    /** Job counts per node, best-effort exactly as `GET /nodes` composes them. */
    private async withLoad(userId: string, nodes: FleetNodeView[]): Promise<FleetNodeView[]> {
        let load: Awaited<ReturnType<FleetJobService['loadByNodeForUser']>> = {};
        try {
            load = await this.jobs.loadByNodeForUser(userId);
        } catch {
            load = {};
        }
        return nodes.map(
            (node): FleetNodeView => ({
                ...node,
                load: node.persisted ? (load[node.id] ?? null) : null,
            }),
        );
    }
}
