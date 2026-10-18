import type { FleetNodeView } from '@ever-works/contracts';

/**
 * Shared pieces of FL-03's five "needs a look" producers: which computers a
 * producer looks at, the routes their actions open, and the ENGLISH renderings
 * Agents, MCP and the CLI show (the web renders each item's `messageKey` and
 * `params` in the viewer's language instead).
 */

/** The computer page (CONTRACTS §11.1 `/fleet/computers/[id]?tab=`). */
export function computerRoute(nodeId: string, tab: 'overview' | 'settings' = 'overview'): string {
    return `/fleet/computers/${encodeURIComponent(nodeId)}?tab=${tab}`;
}

/**
 * Stored computers that have checked in at least once. Live-merged cluster
 * rows are never stored and carry no machine facts (README rule 18), and an
 * enrolling row has reported nothing yet.
 */
export function reportingNodes(nodes: readonly FleetNodeView[]): FleetNodeView[] {
    return nodes.filter(
        (node) => node.persisted !== false && node.kind !== 'k8s' && node.status !== 'enrolling',
    );
}

/** What the CLI is called in a sentence. */
export function cliDisplayName(provider: string): string {
    switch (provider) {
        case 'claude-code':
            return 'Claude Code';
        case 'codex':
            return 'Codex';
        default:
            return provider;
    }
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Binary, labelled binary — `6 GiB`, `1.5 GiB`, `512 MiB` — as the node itself speaks of its floor. */
export function formatBinaryBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
    if (bytes >= 10 * GIB) return `${Math.round(bytes / GIB)} GiB`;
    if (bytes >= GIB) return `${(bytes / GIB).toFixed(1).replace(/\.0$/, '')} GiB`;
    return `${Math.round(bytes / MIB)} MiB`;
}

/** An unambiguous instant for a sentence an Agent reads: `Sun 19 Oct 01:00 UTC`. */
export function formatUtcInstant(iso: string): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return iso;
    const day = date.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
    });
    const time = date.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
    });
    return `${day} ${time} UTC`;
}

/** The first parseable instant among the candidates, else `fallback` — a stable `since`. */
export function firstInstant(
    fallback: Date,
    ...candidates: Array<string | null | undefined>
): string {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) {
            return new Date(candidate).toISOString();
        }
    }
    return fallback.toISOString();
}
