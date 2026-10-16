'use client';

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, User, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePathname } from '@/i18n/navigation';
import {
    RECORD_TABS,
    RECORD_TAB_PARAM,
    parseRecordTab,
    recordTabHref,
    type RecordListView,
} from '@/lib/record-visibility';

const TAB_ICON: Record<RecordListView, typeof User> = {
    mine: User,
    shared: Users,
    organization: Building2,
};

/**
 * Record visibility (EW-P1-3, spec §7) — the **Mine | Shared with me | Organization**
 * tabs on `/tasks`, `/goals`, `/missions`, `/ideas` and `/agents`. `Mine` is the default
 * and keeps today's URL; the tab lives in `?tab=` and every other filter is kept.
 */
export function RecordViewTabs({ className }: { className?: string }) {
    const t = useTranslations('recordVisibility.tabs');
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const active = parseRecordTab(searchParams.get(RECORD_TAB_PARAM));
    const current = new URLSearchParams(searchParams.toString());

    return (
        <div
            className={`mb-4 flex flex-wrap items-center gap-2 ${className ?? ''}`}
            role="tablist"
            aria-label={t('label')}
            data-testid="record-view-tabs"
        >
            {RECORD_TABS.map((tab) => {
                const Icon = TAB_ICON[tab];
                return (
                    <Button
                        key={tab}
                        href={recordTabHref(pathname, current, tab)}
                        variant={active === tab ? 'primary' : 'secondary'}
                        size="sm"
                        role="tab"
                        aria-selected={active === tab}
                        className="gap-1.5"
                        data-testid={`record-view-tab-${tab}`}
                    >
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                        {t(tab)}
                    </Button>
                );
            })}
        </div>
    );
}
