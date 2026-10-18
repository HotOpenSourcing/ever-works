import { registerOverviewBlock } from '../registry';

/**
 * Computer health (FL-03) — what this epic contributes to the Fleet UI module
 * registry (README D9). Imported once by the page that renders the registry
 * (FL-01's computer page); importing it twice is harmless — an id registers
 * once.
 *
 * The block renders FIRST on the Overview tab: it carries the computer's state
 * sentence and its fix, which every other block reads below.
 */
export const HEALTH_METRICS_BLOCK_ID = 'metrics';

registerOverviewBlock({
    id: HEALTH_METRICS_BLOCK_ID,
    order: 10,
    epic: 'FL-03',
    load: () => import('./overview/HealthMetricsBlock'),
});
