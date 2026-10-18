import { Global, Module } from '@nestjs/common';
import { FleetApiModule } from '../fleet/fleet.module';
import { FleetEnabledGuard } from '../fleet/guards/fleet-enabled.guard';
import { FleetNodeAuthGuard } from '../fleet/guards/fleet-node-auth.guard';
import { TerminalModule } from '../terminal/terminal.module';
import { OwnerOnlyFleetLinkAudience } from './fleet-link-audience';
import { FleetLinkAuthorizer } from './fleet-link.authorizer';
import { FleetLinkController } from './fleet-link.controller';
import { FleetLinkGatewayService } from './fleet-link-gateway.service';
import { FleetLinkRegistry } from './fleet-link.registry';
import { FleetLinkService } from './fleet-link.service';
import { FleetLinkTokenService } from './fleet-link-token.service';
import {
    FLEET_LINK_AUDIENCE,
    FLEET_LINK_DRAIN_NOTIFIER,
    FLEET_LINK_HEARTBEAT_OBSERVER,
    FLEET_LINK_NODE_STATE,
    type FleetLinkDrainNotifier,
    type FleetLinkHeartbeatObserver,
    type FleetLinkNodeStateLookup,
} from './fleet-link.types';
import { FleetOperationsService } from './fleet-operations.service';

/**
 * Fleet node link (FL-02) — the platform end of every machine's one
 * outbound multiplexed socket.
 *
 *   - `FleetLinkGatewayService` — `/ws/fleet/link`, the node's socket;
 *   - `FleetLinkRegistry` — live links, generations, channels, resume;
 *   - `FleetLinkAuthorizer` — existence → kill switch → consent → family audience;
 *   - `FleetLinkService` (also `NodeLinkService`) — the one API every epic calls;
 *   - `FleetOperationsService` — long requests by id;
 *   - `FleetLinkController` — `POST /api/fleet/link-token`, `GET|DELETE /api/fleet/operations/:id`.
 *
 * `@Global()` for the reason `ComputerApiModule` documents: three tokens bound
 * HERE are consumed `@Optional()` by modules that must not import this one —
 * the fleet heartbeat tells the link about consents
 * ({@link FLEET_LINK_HEARTBEAT_OBSERVER}), the node views show the link
 * ({@link FLEET_LINK_NODE_STATE}), and drain-all warns owner sessions
 * ({@link FLEET_LINK_DRAIN_NOTIFIER}). And every later epic's controller
 * injects `FleetLinkService` without importing this module.
 *
 * The family audience is bound to the owner-only default
 * ({@link OwnerOnlyFleetLinkAudience}); the Fleet hub's role derivation
 * (FL-01) rebinds {@link FLEET_LINK_AUDIENCE} — seam owned by FL-01.
 */
@Global()
@Module({
    imports: [FleetApiModule, TerminalModule],
    controllers: [FleetLinkController],
    providers: [
        FleetLinkRegistry,
        FleetLinkTokenService,
        FleetOperationsService,
        FleetLinkAuthorizer,
        FleetLinkService,
        FleetLinkGatewayService,
        { provide: FLEET_LINK_AUDIENCE, useClass: OwnerOnlyFleetLinkAudience },
        {
            provide: FLEET_LINK_HEARTBEAT_OBSERVER,
            useFactory: (registry: FleetLinkRegistry): FleetLinkHeartbeatObserver => ({
                onHeartbeat: (nodeId, consents) => {
                    registry.applyConsents(nodeId, consents);
                },
            }),
            inject: [FleetLinkRegistry],
        },
        {
            provide: FLEET_LINK_NODE_STATE,
            useFactory: (service: FleetLinkService): FleetLinkNodeStateLookup => ({
                linkView: (node) => service.linkView(node),
            }),
            inject: [FleetLinkService],
        },
        {
            provide: FLEET_LINK_DRAIN_NOTIFIER,
            useFactory: (registry: FleetLinkRegistry): FleetLinkDrainNotifier => ({
                drainNodes: (nodeIds, graceSec) => {
                    registry.drainNodes(nodeIds, graceSec);
                },
            }),
            inject: [FleetLinkRegistry],
        },
        // Guards are ordinary providers so Nest can inject them.
        FleetEnabledGuard,
        FleetNodeAuthGuard,
    ],
    exports: [
        FleetLinkService,
        FleetLinkRegistry,
        FleetOperationsService,
        FleetLinkTokenService,
        FleetLinkGatewayService,
        FLEET_LINK_AUDIENCE,
        FLEET_LINK_HEARTBEAT_OBSERVER,
        FLEET_LINK_NODE_STATE,
        FLEET_LINK_DRAIN_NOTIFIER,
    ],
})
export class FleetLinkApiModule {}
