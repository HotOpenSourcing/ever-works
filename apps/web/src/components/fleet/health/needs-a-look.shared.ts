import type { NeedsALookItem } from '@ever-works/contracts';
import { formatBinaryBytes, formatInstant } from './computer-state.shared';

/**
 * Computer health (FL-03) — how the web renders FL-03's "needs a look" items
 * in the viewer's language. The API sends each item with an English `title`
 * (what Agents, MCP and the CLI show) plus a `messageKey` and raw `params`;
 * this turns those into a leaf under `fleet.needsALook.kinds` and the values
 * it interpolates — bytes formatted, reset times in the viewer's zone (FR-11).
 *
 * FL-01's renderer calls it for every item and falls back to the English
 * `title` when it answers null (an item from a producer that ships no key).
 */
export interface NeedsALookCopy {
    /** Leaf under `fleet.needsALook.kinds`. */
    key: string;
    values: Record<string, string | number>;
}

const FL03_KEYS = new Set([
    'diskLowCritical',
    'diskLowWarn',
    'limited',
    'limitedMany',
    'throttledCpu',
    'throttledMemory',
    'throttledDisk',
    'throttled',
    'quarantined',
    'quarantinedNoReason',
    'consentMissing',
    'helperUntrusted',
]);

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function needsALookCopy(item: NeedsALookItem, locale: string): NeedsALookCopy | null {
    const key = item.messageKey;
    if (!key || !FL03_KEYS.has(key)) return null;
    const params = item.params ?? {};
    const name = str(params.name) ?? item.nodeName;

    switch (key) {
        case 'diskLowCritical':
        case 'diskLowWarn': {
            const percent = num(params.percent);
            const free = formatBinaryBytes(num(params.freeBytes)) ?? '';
            const floor = formatBinaryBytes(num(params.floorBytes)) ?? '';
            return percent === null
                ? { key: `${key}NoPercent`, values: { free, floor } }
                : { key, values: { percent, free, floor } };
        }
        case 'limited':
        case 'limitedMany': {
            const until = str(params.until);
            const time = until ? (formatInstant(until, locale)?.local ?? until) : '';
            return { key, values: { cli: str(params.cli) ?? str(params.provider) ?? '', time } };
        }
        case 'throttledCpu':
        case 'throttledMemory':
            return {
                key,
                values: { value: num(params.value) ?? '', limit: num(params.limit) ?? '' },
            };
        case 'throttledDisk':
            return {
                key,
                values: {
                    value: formatBinaryBytes(num(params.value)) ?? '',
                    limit: formatBinaryBytes(num(params.limit)) ?? '',
                },
            };
        case 'throttled': {
            const reason = str(params.reason);
            return reason ? { key, values: { reason } } : { key: 'throttledNoReason', values: {} };
        }
        case 'quarantined': {
            const reason = str(params.reason);
            return reason
                ? { key, values: { name, reason } }
                : { key: 'quarantinedNoReason', values: { name } };
        }
        default:
            return { key, values: { name } };
    }
}
