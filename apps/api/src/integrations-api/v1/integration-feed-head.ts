/**
 * The newest change-feed `seq` an integration key may see — `whoami.feedHead`
 * (contract v1 B.2). Gauzy records it before an initial sync and replays the
 * feed from it afterwards.
 *
 * HOOK for EW-P1-1 (domain events) / EW-P1-4 (`GET /events`): bind
 * `INTEGRATION_FEED_HEAD` to a provider that reads `MAX(domain_events.seq)`
 * over the key's pinned organizations. Until then no event has been recorded,
 * and `'0'` is the true head: a feed read from 0 returns everything recorded
 * after the connection was made.
 */
export const INTEGRATION_FEED_HEAD = Symbol('INTEGRATION_FEED_HEAD');

export interface IntegrationFeedHead {
    head(input: { tenantId: string; organizationIds: string[] }): Promise<string>;
}

export const NO_FEED_HEAD = '0';
