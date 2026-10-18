import {
    Global,
    Inject,
    Injectable,
    Logger,
    Module,
    OnApplicationBootstrap,
    OnApplicationShutdown,
} from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import { COMPUTER_FANOUT_BUS } from '../computer/computer-relay.registry';
import { getRedisUrl } from '../health/service-detection';
import { TERMINAL_FANOUT_BUS } from '../terminal/terminal-relay.registry';
import { RELAY_BUS, type RelayBus } from './relay-bus';
import { InProcessRelayBus } from './relay-bus.in-process';
import { ValkeyRelayBus, type ValkeyRelayBusOptions } from './relay-bus.valkey';
import { RelayComputerFanoutBus, RelayTerminalFanoutBus } from './relay-fanout';

/** The boot error a multi-replica deployment without a bus gets (spec FR-31). It names the setting, never the URL. */
export const RELAY_BUS_REQUIRED_MESSAGE =
    'FLEET_RELAY_REQUIRE_BUS=true but no relay bus is configured: set REDIS_URL to the Valkey every API replica shares, ' +
    'or unset FLEET_RELAY_REQUIRE_BUS on a single-replica deployment.';

/**
 * Pick the relay bus (CONTRACTS R-7): Valkey exactly when a Redis URL is
 * configured, the in-process bus otherwise — and a boot error, not a
 * degraded relay, when `FLEET_RELAY_REQUIRE_BUS=true` names a bus that is
 * not configured. No other setting chooses the mode.
 */
export function createRelayBus(input: {
    url: string | null;
    required: boolean;
    valkey?: Omit<ValkeyRelayBusOptions, 'url'>;
}): RelayBus {
    if (!input.url) {
        if (input.required) throw new Error(RELAY_BUS_REQUIRED_MESSAGE);
        return new InProcessRelayBus();
    }
    return new ValkeyRelayBus({ ...input.valkey, url: input.url });
}

@Injectable()
export class RelayBusLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger('RelayBus');

    constructor(@Inject(RELAY_BUS) private readonly bus: RelayBus) {}

    onApplicationBootstrap(): void {
        this.logger.log(
            this.bus.mode === 'valkey'
                ? `Relay bus: valkey (this replica ${this.bus.replicaId})`
                : 'Relay bus: single-replica (no REDIS_URL) — relays serve this process only',
        );
    }

    async onApplicationShutdown(): Promise<void> {
        await this.bus.close();
    }
}

/**
 * The relay bus for the whole API (FL-02). `@Global()` because the tokens it
 * binds are consumed `@Optional()` by modules that must not import it: the
 * terminal relay (`TERMINAL_FANOUT_BUS`), the computer live view
 * (`COMPUTER_FANOUT_BUS`) and the node link (`RELAY_BUS`). Unbound — a test
 * module, a context without it — each falls back to its in-process default.
 */
@Global()
@Module({
    providers: [
        {
            provide: RELAY_BUS,
            useFactory: (): RelayBus =>
                createRelayBus({
                    url: getRedisUrl(),
                    required: config.fleet.isRelayBusRequired(),
                }),
        },
        {
            provide: TERMINAL_FANOUT_BUS,
            useFactory: (bus: RelayBus) => new RelayTerminalFanoutBus(bus),
            inject: [RELAY_BUS],
        },
        {
            provide: COMPUTER_FANOUT_BUS,
            useFactory: (bus: RelayBus) => new RelayComputerFanoutBus(bus),
            inject: [RELAY_BUS],
        },
        RelayBusLifecycle,
    ],
    exports: [RELAY_BUS, TERMINAL_FANOUT_BUS, COMPUTER_FANOUT_BUS],
})
export class RelayBusModule {}
