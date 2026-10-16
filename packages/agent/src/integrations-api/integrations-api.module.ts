import { Module } from '@nestjs/common';
import { ExternalRecordLinksService } from './external-record-links.service';
import { IntegrationIdempotencyService } from './integration-idempotency.service';
import { IntegrationKbService } from './integration-kb.service';
import { IntegrationResourcesService } from './integration-resources.service';

/**
 * Integration API v1 building blocks (EW-P1-4): external record links and the
 * `Idempotency-Key` store. The controllers live in the API
 * (`apps/api/src/integrations-api/v1/`); this module holds the persistence
 * they share, so it can be tested on every database dialect.
 */
@Module({
    providers: [
        ExternalRecordLinksService,
        IntegrationIdempotencyService,
        IntegrationResourcesService,
        // EW-P3-2 — `GET /kb/documents`, `GET /kb/folders`.
        IntegrationKbService,
    ],
    exports: [
        ExternalRecordLinksService,
        IntegrationIdempotencyService,
        IntegrationResourcesService,
        IntegrationKbService,
    ],
})
export class IntegrationsApiFoundationModule {}
