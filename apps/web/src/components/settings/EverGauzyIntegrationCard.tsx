'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { KeyRound, Plug, Trash2 } from 'lucide-react';
import type { IntegrationKeySummary } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { revokeApiKey } from '@/app/actions/api-keys';
import { ROUTES } from '@/lib/constants';

interface EverGauzyIntegrationCardProps {
    initialKeys: IntegrationKeySummary[];
    /**
     * The API base Ever Gauzy should call, e.g. `https://api.ever.works/api`;
     * `null` when this install exposes no public API URL (set NEXT_PUBLIC_API_URL).
     */
    apiUrl: string | null;
}

/** The deep link that opens the "New integration key" dialog with the Ever Gauzy preset. */
export const EVER_GAUZY_NEW_KEY_HREF = `${ROUTES.DASHBOARD_SETTINGS_API_KEYS}?new=integration&preset=ever-gauzy`;

/**
 * EW-P1-7 — the "Ever Gauzy" card under Settings → Integrations.
 *
 * Connecting is manual (plan decision D1): create an integration key with the
 * Ever Gauzy preset and paste it into Gauzy. The card explains the steps,
 * links to the preset dialog, and lists the active Ever Gauzy keys; revoking
 * one disconnects Ever Gauzy immediately (the key answers `401 invalid_key`).
 */
export function EverGauzyIntegrationCard({ initialKeys, apiUrl }: EverGauzyIntegrationCardProps) {
    const t = useTranslations('dashboard.settings.everGauzy');
    const [keys, setKeys] = useState(initialKeys);
    const [isPending, startTransition] = useTransition();
    const [revoking, setRevoking] = useState<string | null>(null);

    const revoke = (id: string) => {
        if (typeof window !== 'undefined' && !window.confirm(t('revokeHint'))) return;
        setRevoking(id);
        startTransition(async () => {
            const result = await revokeApiKey(id);
            if (result.success) {
                setKeys((prev) => prev.filter((key) => key.id !== id));
                toast.success(t('revokeSuccess'));
            } else {
                toast.error(result.error || t('revokeError'));
            }
            setRevoking(null);
        });
    };

    return (
        <div className="space-y-8" data-testid="ever-gauzy-integration">
            <div className="flex items-start gap-3">
                <Plug
                    className="w-6 h-6 text-text-muted dark:text-text-muted-dark mt-1"
                    aria-hidden
                />
                <div>
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                        {t('title')}
                    </h2>
                    <p className="text-text-muted dark:text-text-muted-dark text-sm">
                        {t('subtitle')}
                    </p>
                </div>
            </div>

            <section className="space-y-3 rounded-lg border border-border dark:border-border-dark p-4">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('howTitle')}
                </h3>
                <ol className="list-decimal pl-5 space-y-1 text-sm text-text dark:text-text-dark">
                    <li>{t('steps.one')}</li>
                    <li>{t('steps.two')}</li>
                    <li>{t('steps.three')}</li>
                </ol>
                <div className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('apiUrlLabel')}:{' '}
                    {apiUrl ? (
                        <code className="font-mono bg-surface-secondary dark:bg-surface-secondary-dark px-1.5 py-0.5 rounded">
                            {apiUrl}
                        </code>
                    ) : (
                        <span className="text-warning">{t('apiUrlMissing')}</span>
                    )}
                </div>
                <Button href={EVER_GAUZY_NEW_KEY_HREF} size="sm" className="text-sm">
                    <KeyRound className="w-4 h-4" />
                    {t('createKey')}
                </Button>
            </section>

            <section className="space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('keysTitle')}
                    </h3>
                    <Link
                        href={ROUTES.DASHBOARD_SETTINGS_API_KEYS}
                        className="text-xs text-primary hover:underline"
                    >
                        {t('manageKeys')}
                    </Link>
                </div>
                {keys.length === 0 ? (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('noKeys')}
                    </p>
                ) : (
                    <ul className="divide-y divide-border dark:divide-border-dark rounded-lg border border-border dark:border-border-dark">
                        {keys.map((key) => (
                            <li
                                key={key.id}
                                className="flex items-center justify-between gap-3 px-4 py-3"
                            >
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-text dark:text-text-dark truncate">
                                        {key.name}
                                    </div>
                                    <div className="text-xs text-text-muted dark:text-text-muted-dark">
                                        <code className="font-mono">{key.prefix}...</code>
                                        {' · '}
                                        {key.organizations.map((org) => org.displayName).join(', ')}
                                        {' · '}
                                        {key.lastUsedAt
                                            ? t('lastUsed', {
                                                  date: new Date(
                                                      key.lastUsedAt,
                                                  ).toLocaleDateString(),
                                              })
                                            : t('neverUsed')}
                                    </div>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-danger hover:text-danger shrink-0"
                                    onClick={() => revoke(key.id)}
                                    loading={isPending && revoking === key.id}
                                    title={t('revokeHint')}
                                >
                                    <Trash2 className="w-4 h-4" />
                                    {t('revoke')}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
