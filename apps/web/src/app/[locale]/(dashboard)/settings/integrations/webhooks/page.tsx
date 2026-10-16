import { webhooksAPI, type WebhookSubscription } from '@/lib/api/webhooks';
import { teamsAPI, type TeamsOrganization } from '@/lib/api/teams';
import { WebhooksSettings } from '@/components/settings/WebhooksSettings';

/**
 * Settings → Webhooks (EW-P1-5): outbound webhook subscriptions — the legacy
 * work/deployment ones and v2 domain-event subscriptions — with their
 * deliveries and redelivery.
 */
export default async function WebhooksSettingsPage() {
    let subscriptions: WebhookSubscription[] = [];
    let organizations: TeamsOrganization[] = [];
    try {
        [subscriptions, organizations] = await Promise.all([
            webhooksAPI.list(),
            teamsAPI.listOrganizations(),
        ]);
    } catch {
        subscriptions = [];
    }
    return <WebhooksSettings initialSubscriptions={subscriptions} organizations={organizations} />;
}
