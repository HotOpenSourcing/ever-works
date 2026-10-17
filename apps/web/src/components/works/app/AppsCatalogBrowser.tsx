'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Search, Star } from 'lucide-react';
import { listAppsCatalogBlueprintsAction } from '@/app/actions/dashboard/apps-catalog';
import type { AppsCatalogBlueprintItem } from '@/lib/api/apps-catalog.types';
import { cn } from '@/lib/utils/cn';

/** Search waits this long after the last keystroke (APW-03 plan §5: 300 ms). */
export const APPS_CATALOG_SEARCH_DEBOUNCE_MS = 300;
/** …and only searches from this many characters (`APPS_CATALOG_SEARCH_MIN_CHARS`). */
export const APPS_CATALOG_SEARCH_MIN_CHARS = 2;

type LoadState =
    | { kind: 'loading' }
    | { kind: 'ready'; items: AppsCatalogBlueprintItem[] }
    | { kind: 'unavailable' }
    | { kind: 'disabled' }
    | { kind: 'error' };

export interface AppsCatalogBrowserProps {
    /** A pick: the form fills the URL with `item.url` and inspects it once. */
    onPick: (item: AppsCatalogBlueprintItem) => void;
    disabled?: boolean;
}

/**
 * APW-01 T22 / APW-03 §5 — "Browse the Apps catalog" on the App Work create form.
 *
 * Lists the App Blueprints (`GET /api/apps-catalog/blueprints`: the `ever-works`
 * repositories carrying the Blueprint topic), searchable from two characters
 * with a 300 ms debounce. Picking a card hands its repository URL to the form,
 * which inspects it once — the Blueprint match itself is the platform's, from
 * inspect, never assumed here.
 */
export function AppsCatalogBrowser({ onPick, disabled }: AppsCatalogBrowserProps) {
    const t = useTranslations('dashboard.workCreation.app.catalog');
    const [query, setQuery] = useState('');
    const [state, setState] = useState<LoadState>({ kind: 'loading' });
    const ticket = useRef(0);

    useEffect(() => {
        const needle = query.trim();
        const effective = needle.length >= APPS_CATALOG_SEARCH_MIN_CHARS ? needle : '';
        const mine = ++ticket.current;
        const timer = window.setTimeout(
            async () => {
                setState({ kind: 'loading' });
                try {
                    const result = await listAppsCatalogBlueprintsAction(effective || undefined);
                    if (mine !== ticket.current) return;
                    if (!result.success) {
                        if (result.code === 'app_works_disabled') setState({ kind: 'disabled' });
                        else if (result.httpStatus === 404) setState({ kind: 'unavailable' });
                        else setState({ kind: 'error' });
                        return;
                    }
                    setState(
                        result.data.available
                            ? { kind: 'ready', items: result.data.items }
                            : { kind: 'unavailable' },
                    );
                } catch {
                    if (mine === ticket.current) setState({ kind: 'error' });
                }
            },
            // The first paint loads at once; typing waits for the debounce.
            mine === 1 ? 0 : APPS_CATALOG_SEARCH_DEBOUNCE_MS,
        );
        return () => window.clearTimeout(timer);
    }, [query]);

    return (
        <div className="space-y-4" data-testid="apps-catalog-browser">
            <label className="relative block">
                <span className="sr-only">{t('searchLabel')}</span>
                <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                    aria-hidden="true"
                />
                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('searchPlaceholder')}
                    disabled={disabled}
                    data-testid="apps-catalog-search"
                    className="w-full rounded-md border border-card-border dark:border-border-secondary-dark bg-transparent py-2 pl-9 pr-3 text-sm"
                />
            </label>

            <div aria-live="polite">
                {state.kind === 'loading' && (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="apps-catalog-loading"
                    >
                        {t('loading')}
                    </p>
                )}
                {state.kind === 'unavailable' && (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="apps-catalog-unavailable"
                    >
                        {t('unavailable')}
                    </p>
                )}
                {state.kind === 'disabled' && (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="apps-catalog-disabled"
                    >
                        {t('disabled')}
                    </p>
                )}
                {state.kind === 'error' && (
                    <p
                        className="text-sm text-red-600 dark:text-red-400"
                        data-testid="apps-catalog-error"
                        role="alert"
                    >
                        {t('error')}
                    </p>
                )}
                {state.kind === 'ready' && state.items.length === 0 && (
                    <p
                        className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        data-testid="apps-catalog-empty"
                    >
                        {query.trim().length >= APPS_CATALOG_SEARCH_MIN_CHARS
                            ? t('noMatches')
                            : t('empty')}
                    </p>
                )}
            </div>

            {state.kind === 'ready' && state.items.length > 0 && (
                <ul
                    className="grid gap-3 @lg/main:grid-cols-2 @3xl/main:grid-cols-3"
                    aria-label={t('listLabel')}
                >
                    {state.items.map((item) => (
                        <li key={item.repo}>
                            <button
                                type="button"
                                onClick={() => onPick(item)}
                                disabled={disabled}
                                data-testid="apps-catalog-card"
                                data-blueprint-id={item.id}
                                aria-label={t('pick', { name: item.name })}
                                className={cn(
                                    'h-full w-full rounded-lg border p-4 text-left transition-colors',
                                    'border-card-border dark:border-border-secondary-dark',
                                    'hover:border-primary focus-visible:border-primary focus-visible:outline-none',
                                )}
                            >
                                <span className="flex items-baseline justify-between gap-2">
                                    <span className="font-semibold text-text dark:text-text-dark">
                                        {item.name}
                                    </span>
                                    {typeof item.stars === 'number' && (
                                        <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                                            <Star className="h-3 w-3" aria-hidden="true" />
                                            {item.stars}
                                        </span>
                                    )}
                                </span>
                                <span className="mt-1 block text-xs text-text-muted dark:text-text-muted-dark">
                                    {item.repo}
                                    {item.spdx ? ` · ${item.spdx}` : ''}
                                </span>
                                {item.summary && (
                                    <span className="mt-2 block text-sm text-text-secondary dark:text-text-secondary-dark">
                                        {item.summary}
                                    </span>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
