'use client';

import { useEffect, useState } from 'react';
import type { FleetNodeHealthView } from '@ever-works/contracts';
import { fetchFleetNodeHealthAction } from '@/app/actions/fleet-health';
import type { FleetComputerPanelProps } from '../../registry';
import { HealthMetrics, type HealthMetricsStatus } from './HealthMetrics';

/**
 * Computer health (FL-03) — the Overview "metrics" block as the FL-01 module
 * registry loads it (`registerOverviewBlock`, see `../register.ts`).
 *
 * Reads `GET /api/fleet/nodes/:id/health` for the freshest snapshot and for
 * whether this deployment keeps history (the footprint line), showing the node
 * row the page already holds while it loads. A failed read shows "Could not
 * load health — Try again" (spec §5.2); a successful clear of a usage limit
 * reads again.
 */
export default function HealthMetricsBlock({ node }: FleetComputerPanelProps) {
    const [status, setStatus] = useState<HealthMetricsStatus>('loading');
    const [view, setView] = useState<FleetNodeHealthView | null>(null);
    // Bumped by Try again / a completed fix; each bump is one read.
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        void fetchFleetNodeHealthAction(node.id).then((result) => {
            if (cancelled) return;
            if (result.success) {
                setView(result.data);
                setStatus('ready');
            } else {
                setStatus('error');
            }
        });
        return () => {
            cancelled = true;
        };
    }, [node.id, attempt]);

    const reload = () => {
        setStatus('loading');
        setAttempt((value) => value + 1);
    };

    const current = view ? { ...node, health: view.snapshot } : node;
    return (
        <HealthMetrics
            node={current}
            status={status}
            historyEnabled={view?.historyEnabled}
            onRetry={reload}
            onActionDone={reload}
        />
    );
}
