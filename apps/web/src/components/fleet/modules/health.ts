import { registerOverviewBlock } from '../registry';

/**
 * Computer health (FL-03) — what this epic adds to the Fleet module registry
 * (README D9, `components/fleet/registry.ts`): the metrics block at the top
 * of every computer page's Overview tab. It carries the computer's state in
 * words and its one fix, so it renders before every other block.
 *
 * No `flag`: the snapshot and the state are report-only and ship on. Only the
 * history behind them is `FLEET_HEALTH_HISTORY_ENABLED`, and the block reads
 * that from the health answer itself.
 */
export const HEALTH_METRICS_BLOCK_ID = 'fl-03.health-metrics';

registerOverviewBlock({
    id: HEALTH_METRICS_BLOCK_ID,
    surface: 'computer',
    order: 10,
    epic: 'FL-03',
    load: () => import('../health/overview/HealthMetricsBlock'),
});
