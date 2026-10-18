'use client';

import { useTranslations } from 'next-intl';
import { isFleetNodeHealthStale, type FleetNodeView } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { relativeTimeParts } from '@/components/dashboard/runner-status.shared';
import { useNow } from './use-now';

/** The offline threshold the platform sweeps by, so "stale" and "offline" agree (FR-5). */
export const HEALTH_STALE_AFTER_MS = 5 * 60_000;

export interface HealthCellsProps {
    node: FleetNodeView;
    now?: number;
    staleAfterMs?: number;
}

/**
 * Computer health (FL-03, spec S1) — the three cells a computer card shows:
 * `cpu 31% · mem 58% · disk 40%` and "checked 48 s ago" (the absolute time in
 * the tooltip). A value the node did not report is "—"; a node whose version
 * reports no health says so; a snapshot older than the offline threshold is
 * dimmed and labelled stale, never shown as current (FR-5, FR-30).
 *
 * Built for FL-01's computer cards (`overview/ComputerCards.tsx`), which own
 * the card itself; this is only the health cells.
 */
export function HealthCells({
    node,
    now: nowProp,
    staleAfterMs = HEALTH_STALE_AFTER_MS,
}: HealthCellsProps) {
    const t = useTranslations('fleet.health');
    const ticking = useNow();
    const now = nowProp ?? ticking;
    const health = node.health ?? null;
    const dash = t('notReported');

    if (!health) {
        return (
            <span
                className="text-xs text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-health-cells"
            >
                <span className="tabular-nums">
                    {t('cellCpu', { value: dash })} · {t('cellMem', { value: dash })} ·{' '}
                    {t('cellDisk', { value: dash })}
                </span>{' '}
                <span>{t('cellsNotReported')}</span>
            </span>
        );
    }

    const stale = isFleetNodeHealthStale(health, now, staleAfterMs);
    const percent = (value: number | undefined) =>
        typeof value === 'number' ? t('percentValue', { value: Math.round(value) }) : dash;
    const relative = relativeTimeParts(health.at, now);
    const ago = relative ? t(`relative.${relative.unit}`, { value: relative.value }) : dash;

    return (
        <span
            className={cn(
                'text-xs text-text-muted dark:text-text-muted-dark',
                stale && 'opacity-60',
            )}
            data-testid="fleet-health-cells"
            data-stale={stale ? 'true' : 'false'}
        >
            <span className="tabular-nums">
                {t('cellCpu', { value: percent(health.cpuPercent) })} ·{' '}
                {t('cellMem', { value: percent(health.memPercent) })} ·{' '}
                {t('cellDisk', { value: percent(health.diskPercent) })}
            </span>{' '}
            <time dateTime={health.at} title={new Date(health.at).toLocaleString()}>
                {stale ? t('stale', { relative: ago }) : t('checkedAgo', { relative: ago })}
            </time>
        </span>
    );
}
