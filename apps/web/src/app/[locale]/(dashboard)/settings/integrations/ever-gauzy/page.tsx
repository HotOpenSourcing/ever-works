import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { apiKeysAPI } from '@/lib/api/api-keys';
import { API_URL } from '@/lib/constants';
import { EverGauzyIntegrationCard } from '@/components/settings/EverGauzyIntegrationCard';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.everGauzy');
    return { title: t('title') };
}

/**
 * The API base Ever Gauzy calls: the PUBLIC origin this install's browsers use
 * (`NEXT_PUBLIC_API_URL`, set on dev / stage / prod), else the same API the
 * web app itself calls (`API_URL`, which defaults to `http://localhost:3100`
 * locally and names the API service under Compose). Never a hard-coded
 * production host: a dev or self-hosted install must name itself.
 */
function publicApiBase(): string | null {
    const publicOrigin = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, '');
    if (!publicOrigin) return isReachableFromOutside(API_URL) ? API_URL : null;
    return publicOrigin.endsWith('/api') ? publicOrigin : `${publicOrigin}/api`;
}

/**
 * Review of EW-P1-7 (CodeRabbit): without `NEXT_PUBLIC_API_URL` the fallback is
 * the web app's own `API_URL`, which under Compose is a service name such as
 * `http://ever-works-api:3100` that Ever Gauzy can never resolve. Only offer it
 * when it is localhost (a developer's own machine) or a dotted host name.
 */
function isReachableFromOutside(url: string): boolean {
    try {
        const host = new URL(url).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host.includes('.');
    } catch {
        return false;
    }
}

/**
 * The Ever Gauzy keys that can still connect: a key past its expiry no longer
 * authenticates, so it is no active connection.
 */
function liveEverGauzyKeys<T extends { integrationKind: string; expiresAt: string | null }>(
    keys: T[],
): T[] {
    const now = Date.now();
    return keys.filter(
        (key) =>
            key.integrationKind === 'ever-gauzy' &&
            (!key.expiresAt || Date.parse(key.expiresAt) > now),
    );
}

/**
 * EW-P1-7 — Settings → Integrations → Ever Gauzy: how to connect manually
 * (plan decision D1) and the active Ever Gauzy integration keys, each with a
 * Revoke that disconnects Ever Gauzy at once.
 */
export default async function EverGauzyIntegrationPage() {
    // A failed read is NOT "no keys": let it reach the error boundary rather
    // than tell the owner Ever Gauzy is disconnected (review, CodeRabbit).
    const keys = await apiKeysAPI.listIntegration();
    return (
        <EverGauzyIntegrationCard initialKeys={liveEverGauzyKeys(keys)} apiUrl={publicApiBase()} />
    );
}
