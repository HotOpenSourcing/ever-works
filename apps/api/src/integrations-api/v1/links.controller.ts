import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
    EXTERNAL_LINK_ENTITY_TYPES,
    type ExternalLinkEntityType,
} from '@ever-works/agent/entities';
import {
    ExternalRecordLinksService,
    type ExternalRecordLinkDto,
    toExternalRecordLinkDto,
} from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    linkSourceOf,
    pinnedOrganizationOf,
    principalOf,
    validationFailed,
} from './integration-request';

/**
 * `GET /api/integrations/v1/links?entityType=&externalId=` — this source's
 * external record links in the `X-Scope-Slug` organization (contract v1 B.6).
 * `PUT` / `DELETE /links/:entityType/:entityId` ship with the write routes.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationLinksController {
    constructor(
        private readonly links: ExternalRecordLinksService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get('links')
    @RequireScopes('links:write')
    @ApiOperation({
        summary: "This source's external record links (filter by entityType / externalId)",
    })
    async list(
        @CurrentUser() user: AuthenticatedUser,
        @Query('entityType') entityType?: string,
        @Query('externalId') externalId?: string,
    ): Promise<{ data: ExternalRecordLinkDto[] }> {
        const principal = principalOf(user);
        if (
            entityType !== undefined &&
            !(EXTERNAL_LINK_ENTITY_TYPES as readonly string[]).includes(entityType)
        ) {
            throw validationFailed(
                'entityType',
                `must be one of ${EXTERNAL_LINK_ENTITY_TYPES.join(', ')}`,
            );
        }
        const rows = await this.links.list(
            {
                organizationId: pinnedOrganizationOf(this.scope.getScope().organizationId),
                source: linkSourceOf(principal),
            },
            {
                entityType: entityType as ExternalLinkEntityType | undefined,
                externalId: externalId || undefined,
            },
        );
        return { data: rows.map(toExternalRecordLinkDto) };
    }
}
