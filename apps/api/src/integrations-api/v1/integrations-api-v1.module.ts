import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { IntegrationWhoamiController } from './whoami.controller';
import { IntegrationOnlyGuard } from './integration-only.guard';

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
    imports: [DatabaseModule],
    controllers: [IntegrationWhoamiController],
    providers: [IntegrationOnlyGuard],
})
export class IntegrationsApiV1Module {}
