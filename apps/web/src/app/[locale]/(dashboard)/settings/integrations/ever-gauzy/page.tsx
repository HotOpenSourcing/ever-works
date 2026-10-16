import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { apiKeysAPI } from '@/lib/api/api-keys';
import { EverGauzyIntegrationCard } from '@/components/settings/EverGauzyIntegrationCard';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.everGauzy');
    return { title: t('title') };
}

/**
 * The browser-facing API base Ever Gauzy calls (`https://api.ever.works/api`
 * in production; the stage / dev / self-hosted origin elsewhere).
 */
function publicApiBase(): string {
    const origin = (process.env.NEXT_PUBLIC_API_URL || 'https://api.ever.works').replace(
        /\/+$/,
        '',
    );
    return origin.endsWith('/api') ? origin : `${origin}/api`;
}

/**
 * EW-P1-7 — Settings → Integrations → Ever Gauzy: how to connect manually
 * (plan decision D1) and the active Ever Gauzy integration keys, each with a
 * Revoke that disconnects Ever Gauzy at once.
 */
export default async function EverGauzyIntegrationPage() {
    let keys: Awaited<ReturnType<typeof apiKeysAPI.listIntegration>> = [];
    try {
        keys = await apiKeysAPI.listIntegration();
    } catch {
        keys = [];
    }
    return (
        <EverGauzyIntegrationCard
            initialKeys={keys.filter((key) => key.integrationKind === 'ever-gauzy')}
            apiUrl={publicApiBase()}
        />
    );
}
