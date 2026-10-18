import type { ComputerFanoutBus } from '../computer/computer-relay.registry';
import type { TerminalFanoutBus } from '../terminal/terminal-relay.registry';
import type { RelayBus } from './relay-bus';

/**
 * The terminal and computer relays' cross-replica seams (`TERMINAL_FANOUT_BUS`,
 * `COMPUTER_FANOUT_BUS`) over the relay bus (CONTRACTS R-7, FR-29). Both
 * registries were written for exactly this: a frame published on one replica
 * fans out on the others, never back to the origin; local truth never
 * depends on it.
 *
 * Each message is the pair `[relayKey, wire]` as JSON under the relay's own
 * topic. With the single-replica bus nothing is ever sent — byte for byte
 * the in-process behaviour these registries had before.
 */

function encodePair(key: string, wire: string): string {
    return JSON.stringify([key, wire]);
}

function decodePair(body: string): [string, string] | null {
    try {
        const value: unknown = JSON.parse(body);
        if (
            Array.isArray(value) &&
            value.length === 2 &&
            typeof value[0] === 'string' &&
            typeof value[1] === 'string' &&
            value[0].length > 0 &&
            value[0].length <= 256
        ) {
            return [value[0], value[1]];
        }
    } catch {
        // not ours
    }
    return null;
}

export const RELAY_TERMINAL_TOPIC = 'relay.terminal';
export const RELAY_COMPUTER_TOPIC = 'relay.computer';

export class RelayTerminalFanoutBus implements TerminalFanoutBus {
    constructor(private readonly bus: RelayBus) {}

    publishRemote(runId: string, wire: string): void {
        this.bus.publish(RELAY_TERMINAL_TOPIC, encodePair(runId, wire));
    }

    onRemote(handler: (runId: string, wire: string) => void): void {
        this.bus.subscribe(RELAY_TERMINAL_TOPIC, (body) => {
            const pair = decodePair(body);
            if (pair) handler(pair[0], pair[1]);
        });
    }
}

/**
 * The computer relay's seam answers whether a peer replica may have taken a
 * frame (its `deliverToNode` reports `requested` to the owner's REST call).
 * Pub/sub cannot say which replica holds a machine's leg, so the answer is
 * "the frame went out and at least one other replica is there" — true when
 * the leg could be elsewhere, false when it certainly is not.
 */
export class RelayComputerFanoutBus implements ComputerFanoutBus {
    constructor(private readonly bus: RelayBus) {}

    publishRemote(sessionId: string, wire: string): boolean {
        return this.bus.publish(RELAY_COMPUTER_TOPIC, encodePair(sessionId, wire));
    }

    onRemote(handler: (sessionId: string, wire: string) => void): void {
        this.bus.subscribe(RELAY_COMPUTER_TOPIC, (body) => {
            const pair = decodePair(body);
            if (pair) handler(pair[0], pair[1]);
        });
    }
}
