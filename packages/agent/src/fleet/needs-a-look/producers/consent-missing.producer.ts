import { Injectable } from '@nestjs/common';
import type { FleetNodeView, NeedsALookItem } from '@ever-works/contracts';
import type { NeedsALookContext, NeedsALookProducer } from '../needs-a-look.producer';
import { computerRoute, firstInstant, reportingNodes } from './health-producer.shared';

/**
 * The consents a node reports in its heartbeat (CONTRACTS §1.1), read
 * STRUCTURALLY: FL-02 adds `consents` to the heartbeat and the node view. Until
 * it lands the field is absent on every row and this producer stays silent —
 * an absent fact is never read as "all off" (FR-30).
 */
interface ReportedConsents {
    work?: unknown;
    attend?: unknown;
    manage?: unknown;
}

/** The command the item names: the commonest next consent. The sentence names all three. */
export const CONSENT_MISSING_START_COMMAND = 'ever-works-node start --work';

/**
 * `consent-missing` (FR-15, spec S10) — one `info` item for a computer that
 * gave no consent beyond enrolment: it heartbeats and reports health, and can
 * do nothing else (no work, no live view, no machine management). Fires only
 * when the node REPORTED `consents` and every one of `work`, `attend` and
 * `manage` is false.
 */
export function consentMissingItems(
    nodes: readonly FleetNodeView[],
    context: Pick<NeedsALookContext, 'now'>,
): NeedsALookItem[] {
    const items: NeedsALookItem[] = [];
    for (const node of reportingNodes(nodes)) {
        const consents = (node as FleetNodeView & { consents?: ReportedConsents | null }).consents;
        if (!consents || typeof consents !== 'object') continue;
        if (consents.work !== false || consents.attend !== false || consents.manage !== false) {
            continue;
        }
        items.push({
            id: `consent-missing:${node.id}`,
            nodeId: node.id,
            severity: 'info',
            kind: 'consent-missing',
            title: `${node.name} only reports health. Start it with --work, --attend or --manage to do more.`,
            detail: `For example, on ${node.name} run: ${CONSENT_MISSING_START_COMMAND}`,
            action: { label: 'Show command', route: computerRoute(node.id) },
            since: firstInstant(context.now, node.createdAt, node.lastHeartbeatAt),
        });
    }
    return items;
}

@Injectable()
export class ConsentMissingProducer implements NeedsALookProducer {
    readonly id = 'fl-03.consent-missing';
    produce(nodes: readonly FleetNodeView[], context: NeedsALookContext): NeedsALookItem[] {
        return consentMissingItems(nodes, context);
    }
}
