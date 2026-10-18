import { Injectable } from '@nestjs/common';
import {
    resolveComputerState,
    type ComputerStateResolution,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look.producer';
import {
    cliDisplayName,
    computerRoute,
    firstInstant,
    formatBinaryBytes,
    formatUtcInstant,
    reportingNodes,
} from './health-producer.shared';

/** The English rendering of a `throttled` state's dimension sentence. */
function throttledTitle(state: ComputerStateResolution): string {
    const { dimension, value, limit, reason } = state.params;
    if (dimension === 'cpu' && value !== undefined && limit !== undefined) {
        return `Pausing new work — CPU is above its ceiling (${value}% of ${limit}%)`;
    }
    if (dimension === 'memory' && value !== undefined && limit !== undefined) {
        return `Pausing new work — memory is above its ceiling (${value} MB of ${limit} MB)`;
    }
    if (dimension === 'disk' && value !== undefined && limit !== undefined) {
        return `Pausing new work — free disk is below its floor (${formatBinaryBytes(value)} of ${formatBinaryBytes(limit)})`;
    }
    return reason ? `Pausing new work — ${reason}` : 'Pausing new work';
}

/**
 * `node-throttled` (FR-13) — one `warn` item for a computer that is
 * `throttled` (a resource ceiling) or `limited` (a model CLI's usage limit),
 * as `resolveComputerState` decides it: the same function the cards, the
 * computer header and the Agent tool use, so the list can never disagree with
 * the state word beside the dot. Both states map to this one kind (the owner's
 * default, spec §8b): "Limited" and "Throttled" are two sentences, not two
 * kinds.
 *
 *   - limited → "Waiting for Claude Code's limit to reset at …" with **Clear
 *     limit now** (the existing, audited `clear-model-throttle` route);
 *   - throttled → "Pausing new work — CPU is above its ceiling (92% of 85%)"
 *     with **Change limits** (the computer's settings).
 *
 * `since` is when the limit window opened, or when the worker state changed:
 * both are stamped once per transition, so the item is stable (FR-17).
 */
export function nodeThrottledItems(
    nodes: readonly FleetNodeView[],
    context: NeedsALookContext,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of reportingNodes(nodes)) {
        const state = resolveComputerState(node, { now: context.now });
        if (state.state === 'limited') {
            const provider = state.params.provider ?? '';
            const until = state.params.until ?? '';
            const count = state.params.limitedCount ?? 1;
            const throttle = (node.modelThrottles ?? []).find(
                (entry) => entry.provider === provider,
            );
            items.push({
                id: `node-throttled:${node.id}`,
                nodeId: node.id,
                nodeName: node.name,
                severity: 'warn',
                kind: 'node-throttled',
                title:
                    count > 1
                        ? `Waiting for model limits to reset — the first, ${cliDisplayName(provider)}, at ${formatUtcInstant(until)}`
                        : `Waiting for ${cliDisplayName(provider)}'s limit to reset at ${formatUtcInstant(until)}`,
                detail: throttle?.reason ?? null,
                messageKey: count > 1 ? 'limitedMany' : 'limited',
                params: { provider, cli: cliDisplayName(provider), until, count },
                action: {
                    label: count > 1 ? 'Clear limits now' : 'Clear limit now',
                    labelKey: count > 1 ? 'clearLimitsNow' : 'clearLimitNow',
                    operation:
                        state.action?.kind === 'clear-model-throttle' && state.action.provider
                            ? { kind: 'clear-model-throttle', provider: state.action.provider }
                            : { kind: 'clear-model-throttle' },
                },
                since: firstInstant(
                    context.now,
                    throttle?.since,
                    node.workerStateChangedAt,
                    node.lastHeartbeatAt,
                ),
            });
        } else if (state.state === 'throttled') {
            const { dimension, value, limit } = state.params;
            items.push({
                id: `node-throttled:${node.id}`,
                nodeId: node.id,
                nodeName: node.name,
                severity: 'warn',
                kind: 'node-throttled',
                title: throttledTitle(state),
                detail: dimension ? (node.workerStateReason ?? null) : null,
                messageKey: dimension
                    ? `throttled${dimension[0].toUpperCase()}${dimension.slice(1)}`
                    : 'throttled',
                params: {
                    dimension: dimension ?? null,
                    value: value ?? null,
                    limit: limit ?? null,
                    reason: state.params.reason ?? null,
                },
                action: {
                    label: 'Change limits',
                    labelKey: 'changeLimits',
                    route: computerRoute(node.id, 'settings'),
                },
                since: firstInstant(context.now, node.workerStateChangedAt, node.lastHeartbeatAt),
            });
        }
    }
    return items;
}

@Injectable()
export class NodeThrottledProducer implements NeedsALookProducer {
    readonly id = 'fl03.node-throttled';
    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return nodeThrottledItems(nodes, context);
    }
}
