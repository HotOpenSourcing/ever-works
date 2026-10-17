'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, Package } from 'lucide-react';
import type { AppRuntimeState } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { AppStatusView, AppTargetView } from '@/lib/api/app-runtime.types';
import { AppTargetCard, APP_TARGET_LEAF } from './AppTargetCard';
import { ConnectClusterDialog } from './ConnectClusterDialog';
import { AppDeployNowButton } from './AppDeployNowButton';

const STATE_LEAF = {
    'not-deployed': 'notDeployed',
    live: 'live',
    degraded: 'degraded',
    down: 'down',
    unreachable: 'unreachable',
    paused: 'paused',
    deleting: 'deleting',
} as const satisfies Record<AppRuntimeState, string>;

export interface AppDeployPageProps {
    work: { id: string; slug: string; name: string };
    initialTarget: AppTargetView;
    /** `null` while `GET app-status` is not deployed on this API. */
    status: AppStatusView | null;
    canEdit: boolean;
}

/**
 * APW-06 T37 — the Deploy tab's App branch (spec §6.1, S1–S3).
 *
 * Rendered by `works/[id]/deploy/page.tsx` for kind `app` instead of the
 * website deploy surface (provider selector, token alerts, website form),
 * none of which applies: an App Work deploys its built image to a Kubernetes
 * cluster through `POST /api/works/:id/deploy`.
 *
 * Shows where the app runs today, the three targets with **Connect your
 * cluster** as the primary action, **Deploy now** once a target is chosen, and
 * a link to the Builds that feed it.
 */
export function AppDeployPage({ work, initialTarget, status, canEdit }: AppDeployPageProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy');
    const tTarget = useTranslations('dashboard.workDetail.appDeploy.target');
    const [target, setTarget] = useState<AppTargetView>(initialTarget);
    const [connectOpen, setConnectOpen] = useState(false);

    const running = status && status.state !== 'not-deployed';
    const stateLine = running
        ? t('runningOn', {
              state: t(`status.${STATE_LEAF[status.state] ?? STATE_LEAF['not-deployed']}`),
              target: tTarget(`${APP_TARGET_LEAF[target.target]}.label`),
          })
        : t('notRunning');

    return (
        <section
            className="space-y-4"
            aria-labelledby="app-deploy-title"
            data-testid="app-deploy-page"
        >
            <div className="space-y-1">
                <h2
                    id="app-deploy-title"
                    className="text-xl font-semibold text-text dark:text-text-dark"
                >
                    {t('title')}
                </h2>
                <p
                    className="text-text-secondary dark:text-text-secondary-dark"
                    data-testid="app-deploy-state"
                >
                    {stateLine}
                </p>
                {(status?.url || status?.sourceOffer) && (
                    <div className="flex flex-wrap gap-4 text-sm">
                        {status?.url && (
                            <a
                                href={status.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                            >
                                {t('openApp')}
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                        )}
                        {status?.sourceOffer && (
                            <a
                                href={status.sourceOffer.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                            >
                                {t('source')}
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                        )}
                    </div>
                )}
            </div>

            <AppTargetCard
                key={`${target.target}-${target.clusterCheckedAt ?? ''}`}
                workId={work.id}
                target={target}
                canEdit={canEdit}
                managedAvailable={false}
                onConnectCluster={() => setConnectOpen(true)}
                onSaved={setTarget}
            />

            {target.target !== 'none' && canEdit && <AppDeployNowButton workId={work.id} />}

            <p className="flex items-center gap-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                <Package className="h-4 w-4" aria-hidden="true" />
                {t('buildsHint')}{' '}
                <Link
                    href={ROUTES.DASHBOARD_WORK_BUILDS(work.id)}
                    className="text-primary underline-offset-2 hover:underline"
                >
                    {t('buildsLink')}
                </Link>
            </p>

            {connectOpen && (
                <ConnectClusterDialog
                    open={connectOpen}
                    onOpenChange={setConnectOpen}
                    workId={work.id}
                    target={target}
                    onSaved={setTarget}
                />
            )}
        </section>
    );
}
