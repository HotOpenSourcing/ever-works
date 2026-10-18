import { Injectable } from '@nestjs/common';
import {
    FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
    resolveComputerState,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look.producer';
import { firstInstant, reportingNodes } from './health-producer.shared';

/**
 * `node-quarantined` (FR-14, spec S4) — one `critical` item for a computer
 * that stopped ITSELF (its worker could not prove an earlier job's process
 * tree dead), with the node's own reason and the exact command that clears it
 * ON that machine. Nothing is offered that the platform cannot do: quarantine
 * is cleared only at the keyboard, so the action is a command to copy, never
 * a button that pretends.
 *
 * Judged by `resolveComputerState`, so an offline computer (whose last report
 * may be stale) reads "offline", not "quarantined". `since` is the instant the
 * worker state changed — stamped once per transition (FR-17).
 */
export function nodeQuarantinedItems(
    nodes: readonly FleetNodeView[],
    context: NeedsALookContext,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of reportingNodes(nodes)) {
        const state = resolveComputerState(node, { now: context.now });
        if (state.state !== 'quarantined') continue;
        const reason = state.params.reason ?? null;
        items.push({
            id: `node-quarantined:${node.id}`,
            nodeId: node.id,
            nodeName: node.name,
            severity: 'critical',
            kind: 'node-quarantined',
            title: reason
                ? `${node.name} stopped itself: ${reason}`
                : `${node.name} stopped itself`,
            detail: `Check that no earlier job is still running there, then run: ${FLEET_NODE_CLEAR_QUARANTINE_COMMAND}`,
            messageKey: reason ? 'quarantined' : 'quarantinedNoReason',
            params: { name: node.name, reason },
            action: {
                label: 'Show command',
                labelKey: 'showCommand',
                command: FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
            },
            since: firstInstant(context.now, node.workerStateChangedAt, node.lastHeartbeatAt),
        });
    }
    return items;
}

@Injectable()
export class NodeQuarantinedProducer implements NeedsALookProducer {
    readonly id = 'fl03.node-quarantined';
    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return nodeQuarantinedItems(nodes, context);
    }
}
