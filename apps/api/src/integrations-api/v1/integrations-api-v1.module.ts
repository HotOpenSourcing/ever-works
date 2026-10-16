import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { DomainEventFeedService, DomainEventsModule } from '@ever-works/agent/domain-events';
import { IntegrationsApiFoundationModule } from '@ever-works/agent/integrations-api';
import { IntegrationWhoamiController } from './whoami.controller';
import { IntegrationEventsController } from './events.controller';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import { IntegrationLinksController } from './links.controller';
import { IntegrationResourcesController } from './resources.controller';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { INTEGRATION_FEED_HEAD, type IntegrationFeedHead } from './integration-feed-head';

/**
 * Integration API v1 — `/api/integrations/v1/*`, the stable contract Ever
 * Gauzy (and any later integration) codes against (plan doc 03 Part B,
 * `docs/specs/features/integrations-api-v1/`).
 *
 * EW-P1-2 ships the first route, `GET /whoami`, because it is about the key
 * itself. The resources (members, agents, teams, works, tasks, events,
 * links, batch) are EW-P1-4 and land in this module.
 */
@Module({
    imports: [DatabaseModule, DomainEventsModule, IntegrationsApiFoundationModule],
    controllers: [
        IntegrationWhoamiController,
        // EW-P1-4 — the change feed and the P1 resource reads.
        IntegrationEventsController,
        IntegrationResourcesController,
        IntegrationLinksController,
    ],
    providers: [
        IntegrationOnlyGuard,
        IntegrationExceptionFilter,
        // `whoami.feedHead` — the GLOBAL change-feed head (EW-P1-1): feed
        // positions are assigned by the relay across every organization, so
        // there is no per-organization head and the pins are not needed here.
        {
            provide: INTEGRATION_FEED_HEAD,
            useFactory: (feed: DomainEventFeedService): IntegrationFeedHead => ({
                head: () => feed.head(),
            }),
            inject: [DomainEventFeedService],
        },
    ],
})
export class IntegrationsApiV1Module {}
