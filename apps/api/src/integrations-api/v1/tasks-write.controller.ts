import {
    Body,
    Controller,
    Delete,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Req,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import { TasksService, TaskPriority, TaskStatus } from '@ever-works/agent/tasks-domain';
import { TeamResourcesService } from '@ever-works/agent/teams';
import {
    assertIfMatch,
    DuplicateExternalRefError,
    ExternalRecordLinksService,
    installationFromOrigin,
    IntegrationIdempotencyService,
    IntegrationResourcesService,
    parseIfMatch,
} from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import { writeAttribution } from '../../auth/integration/integration-attribution';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    runIdempotent,
    type IdempotentRequest,
    type IdempotentResponse,
} from './integration-idempotency';
import {
    linkSourceOf,
    pinnedOrganizationOf,
    principalOf,
    validationFailed,
} from './integration-request';

const PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'p4'] as const;

export class IntegrationExternalRefDto {
    @IsString()
    @Length(1, 100)
    source!: string;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    installationId?: string | null;

    @IsString()
    @Length(1, 200)
    externalId!: string;

    @IsOptional()
    @IsString()
    @MaxLength(2048)
    externalUrl?: string | null;
}

export class IntegrationPrincipalRefDto {
    @IsIn(['user', 'agent'])
    type!: 'user' | 'agent';

    @IsUUID()
    id!: string;
}

/** Contract v1 `requests.schema.json#/$defs/CreateTask`. */
export class IntegrationCreateTaskDto {
    @IsString()
    @Length(1, 200)
    title!: string;

    @IsOptional()
    @IsString()
    @MaxLength(100_000)
    description?: string | null;

    @IsOptional()
    @IsIn(['backlog', 'todo'])
    status?: 'backlog' | 'todo';

    @IsOptional()
    @IsIn(PRIORITIES)
    priority?: (typeof PRIORITIES)[number];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @Length(1, 80, { each: true })
    labels?: string[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsUUID('all', { each: true })
    teamIds?: string[];

    @IsOptional()
    @IsString()
    visibility?: string;

    @IsOptional()
    @IsUUID()
    workId?: string | null;

    @IsOptional()
    @IsUUID()
    missionId?: string | null;

    @IsOptional()
    @IsUUID()
    ideaId?: string | null;

    @IsOptional()
    @IsUUID()
    parentTaskId?: string | null;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => IntegrationPrincipalRefDto)
    assignees?: IntegrationPrincipalRefDto[];

    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationExternalRefDto)
    externalRef?: IntegrationExternalRefDto;
}

/** Contract v1 `requests.schema.json#/$defs/UpdateTask` (no `status`: use /transition). */
export class IntegrationUpdateTaskDto {
    @IsOptional()
    @IsString()
    @Length(1, 200)
    title?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100_000)
    description?: string | null;

    @IsOptional()
    @IsIn(PRIORITIES)
    priority?: (typeof PRIORITIES)[number];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @Length(1, 80, { each: true })
    labels?: string[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsUUID('all', { each: true })
    teamIds?: string[];

    @IsOptional()
    @IsString()
    visibility?: string;

    @IsOptional()
    @IsUUID()
    workId?: string | null;

    @IsOptional()
    @IsUUID()
    parentTaskId?: string | null;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/**
 * Task writes of `/api/integrations/v1` (EW-P1-4, contract v1 B.6). They call
 * the same domain service as the app (`TasksService`), so every rule, event
 * and notification is the app's own:
 *
 * - `POST /tasks` needs an `Idempotency-Key`; `externalRef` links the new task
 *   to its external record, and a repeat with the same `externalRef` answers
 *   `200` with the existing task instead of a duplicate. A task starts in
 *   `backlog` (default) or `todo`; moves go through `/transition`.
 * - `PATCH` / `DELETE /tasks/:id` take an optional `If-Match: "<version>"`
 *   (`412 version_mismatch` when stale).
 * - Writes are attributed to the integration (`createdByType: integration`)
 *   unless `X-Act-As-User` names a person, and carry `X-Sync-Origin` into the
 *   events' `origin.tag`.
 * - `visibility`: `private` answers `422 domain_rule`; `team` / `organization`
 *   are accepted and applied by record visibility (D11) — the task's teams
 *   decide it.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationTasksWriteController {
    constructor(
        private readonly tasks: TasksService,
        private readonly teamResources: TeamResourcesService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly resources: IntegrationResourcesService,
        private readonly scope: ScopeContextService,
    ) {}

    @Post('tasks')
    @RequireScopes('tasks:write')
    @ApiOperation({
        summary: 'Create a task (Idempotency-Key required; externalRef de-duplicates)',
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateTaskDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        const source = linkSourceOf(principal);
        assertWritableVisibility(dto.visibility);
        return runIdempotent(this.idempotency, principal, req, res, async () => {
            const linkScope = dto.externalRef
                ? {
                      organizationId,
                      tenantId: principal.tenantId,
                      source: dto.externalRef.source,
                      installationId: installationFromOrigin(
                          dto.externalRef.installationId,
                          syncOrigin,
                          dto.externalRef.source,
                      ),
                      integrationKeyId: principal.keyId,
                  }
                : null;
            if (linkScope && dto.externalRef) {
                const existing = await this.links.findByExternal(
                    linkScope,
                    'task',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    return {
                        status: 200,
                        body: (
                            await this.resources.get(
                                'task',
                                organizationId,
                                existing.entityId,
                                source,
                            )
                        ).dto,
                    };
                }
            }

            const [teamId, ...extraTeams] = dto.teamIds ?? [];
            const createdBy = writeAttribution(user);
            const task = await this.tasks.create(
                user.userId,
                {
                    title: dto.title,
                    description: dto.description ?? null,
                    status: dto.status === 'todo' ? TaskStatus.TODO : TaskStatus.BACKLOG,
                    priority: dto.priority as TaskPriority | undefined,
                    labels: dto.labels ?? null,
                    teamId: teamId ?? null,
                    workId: dto.workId ?? null,
                    missionId: dto.missionId ?? null,
                    ideaId: dto.ideaId ?? null,
                    parentTaskId: dto.parentTaskId ?? null,
                    createdByType: createdBy.type,
                    createdById: createdBy.id,
                },
                this.scope.getScope() as never,
            );

            if (linkScope && dto.externalRef) {
                try {
                    await this.links.create(linkScope, {
                        entityType: 'task',
                        entityId: task.id,
                        externalId: dto.externalRef.externalId,
                        externalUrl: dto.externalRef.externalUrl ?? null,
                    });
                } catch (error) {
                    // A concurrent create with the same externalRef won: undo ours
                    // and answer theirs.
                    await this.tasks.remove(user.userId, task.id, this.scope.getScope() as never);
                    if (error instanceof DuplicateExternalRefError && error.side === 'external') {
                        const winner = await this.links.findByExternal(
                            linkScope,
                            'task',
                            dto.externalRef.externalId,
                        );
                        if (winner) {
                            return {
                                status: 200,
                                body: (
                                    await this.resources.get(
                                        'task',
                                        organizationId,
                                        winner.entityId,
                                        source,
                                    )
                                ).dto,
                            };
                        }
                    }
                    throw error;
                }
            }
            for (const extra of extraTeams) {
                await this.teamResources.attach(user.userId, organizationId, extra, {
                    resourceType: 'task',
                    resourceId: task.id,
                });
            }
            for (const assignee of dto.assignees ?? []) {
                await this.tasks.addAssignee(
                    user.userId,
                    task.id,
                    assignee.type,
                    assignee.id,
                    this.scope.getScope() as never,
                );
            }
            const created = await this.resources.get('task', organizationId, task.id, source);
            if (created.etag) res.setHeader('ETag', created.etag);
            return { status: 201, body: created.dto };
        });
    }

    @Patch('tasks/:id')
    @RequireScopes('tasks:write')
    @ApiOperation({ summary: 'Update a task (If-Match optional; no status — use /transition)' })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateTaskDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown>> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        const source = linkSourceOf(principal);
        if (Object.keys(dto).length === 0)
            throw validationFailed('body', 'must change at least one field');
        assertWritableVisibility(dto.visibility);
        const current = await this.resources.get('task', organizationId, id, source);
        assertIfMatch(expectedVersion(ifMatch), Number(current.dto.version));

        const patch: Record<string, unknown> = {};
        if (dto.title !== undefined) patch.title = dto.title;
        if (dto.description !== undefined) patch.description = dto.description;
        if (dto.priority !== undefined) patch.priority = dto.priority;
        if (dto.labels !== undefined) patch.labels = dto.labels;
        if (dto.workId !== undefined) patch.workId = dto.workId;
        if (dto.parentTaskId !== undefined) patch.parentTaskId = dto.parentTaskId;
        if (dto.teamIds !== undefined) patch.teamId = dto.teamIds[0] ?? null;
        if (Object.keys(patch).length > 0) {
            await this.tasks.update(user.userId, id, patch, this.scope.getScope() as never);
        }
        if (dto.teamIds !== undefined) {
            await this.syncExtraTeams(
                user.userId,
                organizationId,
                id,
                current.dto,
                dto.teamIds.slice(1),
            );
        }
        const updated = await this.resources.get('task', organizationId, id, source);
        if (updated.etag) res.setHeader('ETag', updated.etag);
        return updated.dto;
    }

    @Delete('tasks/:id')
    @RequireScopes('tasks:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a task (If-Match optional)' })
    async remove(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Headers('if-match') ifMatch: string | undefined,
    ): Promise<void> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        const current = await this.resources.get(
            'task',
            organizationId,
            id,
            linkSourceOf(principal),
        );
        assertIfMatch(expectedVersion(ifMatch), Number(current.dto.version));
        await this.tasks.remove(user.userId, id, this.scope.getScope() as never);
        await this.links.removeAllFor(organizationId, 'task', id);
    }

    /** `teamIds[1..]` are `team_resources` links: attach the new ones, detach the dropped ones. */
    private async syncExtraTeams(
        userId: string,
        organizationId: string,
        taskId: string,
        current: Record<string, unknown>,
        wanted: string[],
    ): Promise<void> {
        const currentTeams = (current.teamIds as string[] | undefined) ?? [];
        const currentLinks = currentTeams.slice(1);
        for (const teamId of wanted.filter((team) => !currentLinks.includes(team))) {
            await this.teamResources.attach(userId, organizationId, teamId, {
                resourceType: 'task',
                resourceId: taskId,
            });
        }
        for (const teamId of currentLinks.filter((team) => !wanted.includes(team))) {
            await this.teamResources.detach(organizationId, teamId, 'task', taskId);
        }
    }
}

/** `If-Match` → version | null (`400 validation_failed` when not one this API issued). */
function expectedVersion(header: string | undefined): number | null {
    const parsed = parseIfMatch(header);
    if (parsed === undefined)
        throw validationFailed('If-Match', 'must be the "<version>" ETag of the record');
    return parsed;
}

/** Integrations may set `team` or `organization` only (contract v1 §1.3). */
function assertWritableVisibility(visibility: string | undefined): void {
    if (visibility === undefined) return;
    if (visibility === 'private') {
        throw new IntegrationHttpException(
            422,
            'domain_rule',
            'An integration cannot make a record private.',
            {
                field: 'visibility',
            },
        );
    }
    if (visibility !== 'team' && visibility !== 'organization') {
        throw validationFailed('visibility', 'must be team or organization');
    }
}
