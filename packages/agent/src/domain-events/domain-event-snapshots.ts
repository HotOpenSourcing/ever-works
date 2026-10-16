import {
    getWorkCapabilities,
    type IntegrationAgentDto,
    type IntegrationInboxItemDto,
    type IntegrationMemberDto,
    type IntegrationOrganizationDto,
    type IntegrationTaskCommentDto,
    type IntegrationTaskDto,
    type IntegrationTeamDto,
    type IntegrationVisibility,
    type IntegrationWorkDto,
} from '@ever-works/contracts';
import type { EntityManager } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { ExternalIdentity } from '../entities/external-identity.entity';
import { InboxItem } from '../entities/inbox-item.entity';
import { Organization } from '../entities/organization.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { Task } from '../entities/task.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskBlock } from '../entities/task-block.entity';
import { TaskChatMessage } from '../entities/task-chat-message.entity';
import { TaskRelation } from '../entities/task-relation.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { TeamResource } from '../entities/team-resource.entity';
import { User } from '../entities/user.entity';
import { Work } from '../entities/work.entity';
import { WorkMember } from '../entities/work-member.entity';

/**
 * Integration DTO snapshots (integration contract v1, B.6) built from the
 * database with the caller's `EntityManager`, so an event's `data` reflects
 * the state its transaction is about to commit. The integration API (EW-P1-4)
 * serves the same builders, so an event's `data` and a GET of the same version
 * are identical.
 *
 * Tasks and agents carry their STORED record visibility (EW-P1-3,
 * `visibility` / `visibilityExplicit`): a `private` record's snapshot says
 * `private`, the recorder stores that on the event row, and the feed and
 * webhooks v2 never serve such an event (only the id-only
 * `*.visibility_changed` notice). Works carry no visibility column: theirs is
 * derived — `team` when the work sits on a team, else `organization`.
 */

/** A DTO plus the scope of the row it came from (the DTO has no tenant; personal rows have no org). */
export interface AggregateSnapshot<T> {
    readonly dto: T;
    readonly tenantId: string | null;
    readonly organizationId: string | null;
}

const iso = (value: Date | string | null | undefined): string | null =>
    value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;
const isoRequired = (value: Date | string | null | undefined): string =>
    iso(value) ?? new Date(0).toISOString();

/** Public origin of the web app (`WEB_URL`), without a trailing slash; `null` when unset. */
export function webAppOrigin(): string | null {
    const value = process.env.WEB_URL?.trim();
    return value ? value.replace(/\/+$/, '') : null;
}

const webUrl = (path: string): string | null => {
    const origin = webAppOrigin();
    return origin ? `${origin}${path}` : null;
};

function derivedVisibility(teamIds: readonly string[]): IntegrationVisibility {
    return teamIds.length > 0 ? 'team' : 'organization';
}

/**
 * A record's stored visibility (EW-P1-3), or the derived value for a row read
 * before the column existed. `private` passes through (typed as the DTO's
 * visibility on purpose): it is what keeps the event out of the feed.
 */
function recordVisibility(
    row: { visibility?: string | null; visibilityExplicit?: boolean | null },
    teamIds: readonly string[],
): { visibility: IntegrationVisibility; visibilityExplicit: boolean } {
    const stored = row.visibility;
    if (stored === 'private' || stored === 'team' || stored === 'organization') {
        return {
            visibility: stored as IntegrationVisibility,
            visibilityExplicit: row.visibilityExplicit === true,
        };
    }
    return { visibility: derivedVisibility(teamIds), visibilityExplicit: false };
}

function unique<T>(values: readonly T[]): T[] {
    return [...new Set(values)];
}

/** The teams a resource is linked to through `team_resources`, oldest link first. */
export async function teamResourceIds(
    manager: EntityManager,
    resourceType: string,
    resourceId: string,
): Promise<string[]> {
    const rows = await manager.getRepository(TeamResource).find({
        where: { resourceType: resourceType as TeamResource['resourceType'], resourceId },
        order: { createdAt: 'ASC' },
    });
    return rows.map((row) => row.teamId);
}

/** The task's integration DTO, or `null` when the row is gone. */
export async function buildTaskSnapshot(
    manager: EntityManager,
    taskId: string,
): Promise<AggregateSnapshot<IntegrationTaskDto> | null> {
    const task = await manager.getRepository(Task).findOne({ where: { id: taskId } });
    if (!task) return null;
    const [assignees, watchers, approvers, reviewers, blocks, relations, resourceTeams] =
        await Promise.all([
            manager.getRepository(TaskAssignee).find({ where: { taskId } }),
            manager.getRepository(TaskWatcher).find({ where: { taskId } }),
            manager.getRepository(TaskApprover).find({ where: { taskId } }),
            manager.getRepository(TaskReviewer).find({ where: { taskId } }),
            manager.getRepository(TaskBlock).find({ where: { taskId } }),
            manager.getRepository(TaskRelation).find({ where: { taskId } }),
            teamResourceIds(manager, 'task', taskId),
        ]);
    const teamIds = unique([...(task.teamId ? [task.teamId] : []), ...resourceTeams]);
    const createdByType = (task.createdByType as string) || 'user';
    const dto: IntegrationTaskDto = {
        id: task.id,
        organizationId: task.organizationId ?? '',
        version: Number(task.version) || 1,
        createdAt: isoRequired(task.createdAt),
        updatedAt: isoRequired(task.updatedAt),
        ...recordVisibility(task, teamIds),
        owner: { type: 'user', id: task.userId },
        createdBy: {
            type:
                createdByType === 'agent' || createdByType === 'integration'
                    ? createdByType
                    : 'user',
            id: task.createdById || task.userId,
        },
        externalLinks: [],
        teamIds,
        slug: task.slug,
        title: task.title,
        description: task.description ?? null,
        status: task.status as IntegrationTaskDto['status'],
        priority: task.priority as IntegrationTaskDto['priority'],
        labels: unique(task.labels ?? []),
        workId: task.workId ?? null,
        missionId: task.missionId ?? null,
        ideaId: task.ideaId ?? null,
        goalId: task.goalId ?? null,
        agentId: task.agentId ?? null,
        parentTaskId: task.parentTaskId ?? null,
        assignees: assignees.map((row) => ({
            type: row.assigneeType as 'user' | 'agent',
            id: row.assigneeId,
        })),
        watchers: unique(watchers.map((row) => row.userId)),
        approvers: approvers.map((row) => ({
            type: row.approverType as 'user' | 'agent',
            id: row.approverId,
            state: row.approvalState as 'pending' | 'approved' | 'rejected',
        })),
        reviewers: reviewers.map((row) => ({
            type: row.reviewerType as 'user' | 'agent',
            id: row.reviewerId,
            state: row.reviewState as 'pending' | 'requested-changes' | 'approved',
        })),
        blockedBy: unique(blocks.map((row) => row.blockedByTaskId)),
        relations: relations.map((row) => ({
            taskId: row.relatedTaskId,
            kind: row.kind as 'related' | 'duplicates' | 'follow-up',
        })),
        startedAt: iso(task.startedAt),
        completedAt: iso(task.completedAt),
        isRecurringTemplate: !!task.isRecurring,
        hiddenFromBoard: !!task.hiddenFromBoard,
        runtime: {
            prUrl: task.prUrl ?? null,
            prState: (task.prState as string | null | undefined) ?? null,
            ciState: (task.ciState as string | null | undefined) ?? null,
            latestRunStatus: (task.latestRunStatus as string | null | undefined) ?? null,
        },
        webUrl: webUrl(`/tasks/${task.id}`),
    };
    return { dto, tenantId: task.tenantId ?? null, organizationId: task.organizationId ?? null };
}

/**
 * A task chat message as the comment DTO. A message row is not always stamped
 * with its scope (raw routes run without one), so the parent task's
 * organization is the fallback.
 */
export function toTaskCommentDto(
    message: TaskChatMessage,
    taskOrganizationId?: string | null,
): IntegrationTaskCommentDto {
    const authorType = (message.authorType as string) || 'user';
    return {
        id: message.id,
        taskId: message.taskId,
        organizationId: message.organizationId ?? taskOrganizationId ?? '',
        authorType: authorType === 'agent' || authorType === 'integration' ? authorType : 'user',
        authorId: message.authorId,
        // EW-P1-2 — display attribution of an integration author (null otherwise).
        externalAuthor:
            authorType === 'integration' && message.externalAuthor
                ? {
                      name: message.externalAuthor.name,
                      avatarUrl: message.externalAuthor.avatarUrl ?? null,
                      source: message.externalAuthor.source,
                  }
                : null,
        body: message.body,
        mentions: (message.mentions ?? []).map((mention) => ({
            type: mention.type,
            id: mention.id ?? null,
            slug: mention.slug ?? null,
        })),
        editedAt: iso(message.editedAt),
        createdAt: isoRequired(message.createdAt),
        updatedAt: isoRequired(message.updatedAt),
        externalLinks: [],
    };
}

/** The team's integration DTO (members and resources embedded), or `null` when gone. */
export async function buildTeamSnapshot(
    manager: EntityManager,
    teamId: string,
): Promise<AggregateSnapshot<IntegrationTeamDto> | null> {
    const team = await manager.getRepository(Team).findOne({ where: { id: teamId } });
    if (!team) return null;
    const [members, resources] = await Promise.all([
        manager.getRepository(TeamMember).find({ where: { teamId }, order: { createdAt: 'ASC' } }),
        manager
            .getRepository(TeamResource)
            .find({ where: { teamId }, order: { createdAt: 'ASC' } }),
    ]);
    const dto: IntegrationTeamDto = {
        id: team.id,
        organizationId: team.organizationId ?? '',
        version: Number(team.version) || 1,
        createdAt: isoRequired(team.createdAt),
        updatedAt: isoRequired(team.updatedAt),
        visibility: 'organization',
        visibilityExplicit: false,
        owner: { type: 'user', id: team.userId },
        createdBy: { type: 'user', id: team.userId },
        externalLinks: [],
        name: team.name,
        slug: team.slug,
        description: team.description ?? null,
        parentTeamId: team.parentTeamId ?? null,
        managerAgentId: team.managerAgentId ?? null,
        avatarIcon: team.avatarIcon ?? null,
        members: members.map((row) => ({
            memberType: row.memberType as 'user' | 'agent',
            memberId: row.memberId,
            role: row.role as 'lead' | 'member',
        })),
        resources: resources.map((row) => ({
            resourceType: row.resourceType,
            resourceId: row.resourceId,
        })),
        webUrl: webUrl(`/teams/${team.id}`),
    };
    return { dto, tenantId: team.tenantId ?? null, organizationId: team.organizationId ?? null };
}

/** The agent's integration DTO (team scope = its team memberships), or `null` when gone. */
export async function buildAgentSnapshot(
    manager: EntityManager,
    agentId: string,
): Promise<AggregateSnapshot<IntegrationAgentDto> | null> {
    const agent = await manager.getRepository(Agent).findOne({ where: { id: agentId } });
    if (!agent) return null;
    const memberships = await manager
        .getRepository(TeamMember)
        .find({ where: { memberType: 'agent' as TeamMember['memberType'], memberId: agentId } });
    const teamIds = unique(memberships.map((row) => row.teamId));
    const avatar = agent as unknown as { avatarMode?: string; avatarIcon?: string | null };
    const dto: IntegrationAgentDto = {
        id: agent.id,
        organizationId: agent.organizationId ?? '',
        version: Number(agent.version) || 1,
        createdAt: isoRequired(agent.createdAt),
        updatedAt: isoRequired(agent.updatedAt),
        ...recordVisibility(agent, teamIds),
        owner: { type: 'user', id: agent.userId },
        createdBy: { type: 'user', id: agent.userId },
        externalLinks: [],
        teamIds,
        name: agent.name,
        slug: agent.slug,
        title: agent.title ?? null,
        capabilities: agent.capabilities ?? null,
        status: agent.status as IntegrationAgentDto['status'],
        scope: agent.scope as IntegrationAgentDto['scope'],
        scopeTargetId: agent.scopeTargetId,
        reportsToAgentId: agent.reportsToAgentId ?? null,
        avatar: {
            mode: (avatar.avatarMode as 'initials' | 'icon' | 'image') || 'initials',
            icon: avatar.avatarIcon ?? null,
            url: null,
        },
        modelId: agent.modelId ?? null,
        lastRunAt: iso(agent.lastRunAt),
        webUrl: webUrl(`/agents/${agent.id}`),
    };
    return { dto, tenantId: agent.tenantId ?? null, organizationId: agent.organizationId ?? null };
}

/** The work's integration DTO (members and repositories embedded), or `null` when gone. */
export async function buildWorkSnapshot(
    manager: EntityManager,
    workId: string,
): Promise<AggregateSnapshot<IntegrationWorkDto> | null> {
    const work = await manager.getRepository(Work).findOne({ where: { id: workId } });
    if (!work) return null;
    const [members, teamIds] = await Promise.all([
        manager.getRepository(WorkMember).find({ where: { workId }, order: { createdAt: 'ASC' } }),
        teamResourceIds(manager, 'work', workId),
    ]);
    const repos = getWorkCapabilities(work.kind).repos;
    const repoUrls: string[] = [];
    const host = (work.gitProvider || 'github') === 'github' ? 'https://github.com' : null;
    const roles: Array<'work' | 'data' | 'website'> = ['work', 'data', 'website'];
    for (const role of roles) {
        if (!repos[role] || !host) continue;
        const repo =
            role === 'work'
                ? work.getMainRepo()
                : role === 'data'
                  ? work.getDataRepo()
                  : work.getWebsiteRepo();
        const owner = work.getRepoOwner(role);
        if (owner && repo) repoUrls.push(`${host}/${owner}/${repo}`);
    }
    const memberRefs = [
        { userId: work.userId, role: 'owner' as const },
        ...members
            .filter((row) => row.userId !== work.userId)
            .map((row) => ({
                userId: row.userId,
                role: row.role as 'manager' | 'editor' | 'viewer',
            })),
    ];
    const dto: IntegrationWorkDto = {
        id: work.id,
        organizationId: work.organizationId ?? '',
        version: Number(work.version) || 1,
        createdAt: isoRequired(work.createdAt),
        updatedAt: isoRequired(work.updatedAt),
        visibility: derivedVisibility(teamIds),
        visibilityExplicit: false,
        owner: { type: 'user', id: work.userId },
        createdBy: { type: 'user', id: work.userId },
        externalLinks: [],
        teamIds,
        name: work.name,
        slug: work.slug,
        description: work.description ?? null,
        kind: work.kind ?? 'default',
        status: (work.status ?? 'active') as IntegrationWorkDto['status'],
        website: work.website || null,
        repoUrls: unique(repoUrls),
        members: memberRefs,
        webUrl: webUrl(`/works/${work.id}`),
    };
    return { dto, tenantId: work.tenantId ?? null, organizationId: work.organizationId ?? null };
}

/** The organization's integration DTO, or `null` when gone. */
export async function buildOrganizationSnapshot(
    manager: EntityManager,
    organizationId: string,
): Promise<AggregateSnapshot<IntegrationOrganizationDto> | null> {
    const org = await manager
        .getRepository(Organization)
        .findOne({ where: { id: organizationId } });
    if (!org) return null;
    const dto: IntegrationOrganizationDto = {
        id: org.id,
        tenantId: org.tenantId,
        slug: org.slug,
        displayName: org.displayName,
        legalName: org.legalName ?? null,
        countryCode: org.countryCode ?? null,
        version: Number(org.version) || 1,
        createdAt: isoRequired(org.createdAt),
        updatedAt: isoRequired(org.updatedAt),
        webUrl: webUrl(`/${org.slug}/dashboard`),
    };
    return { dto, tenantId: org.tenantId ?? null, organizationId: org.id };
}

/** One roster row as the member DTO, or `null` when the user is gone. */
export async function buildMemberSnapshot(
    manager: EntityManager,
    member: Pick<
        OrganizationMember,
        'organizationId' | 'userId' | 'role' | 'joinedAt' | 'updatedAt'
    >,
): Promise<IntegrationMemberDto | null> {
    const user = await manager.getRepository(User).findOne({ where: { id: member.userId } });
    if (!user) return null;
    const identities = await manager
        .getRepository(ExternalIdentity)
        .find({ where: { userId: member.userId } });
    return {
        organizationId: member.organizationId,
        userId: member.userId,
        username: user.username,
        displayName: null,
        email: user.email ?? null,
        emailVerified: !!user.emailVerified,
        avatarUrl: user.avatar || null,
        role: (member.role as string) || 'member',
        isActive: !!user.isActive,
        joinedAt: isoRequired(member.joinedAt),
        updatedAt: isoRequired(member.updatedAt ?? member.joinedAt),
        everIdSubjects: identities.map((row) => ({ issuer: row.issuer, subject: row.subject })),
    };
}

/**
 * EW-P3-1 — one inbox row as the integration DTO (`inbox.item.*` event
 * `data`, `GET /inbox/items[/:id]`). Pure: the GET and the event of the same
 * version are built by this one mapper, so they are identical. `sourceMeta`
 * (fleet provenance: node names, branches, mount directories) is not exposed.
 */
export function toIntegrationInboxItemDto(row: InboxItem): IntegrationInboxItemDto {
    const options = Array.isArray(row.options)
        ? row.options.map((option) => {
              const out: {
                  id: string;
                  label: string;
                  description?: string;
                  recommended?: boolean;
              } = { id: option.id, label: option.label };
              if (typeof option.description === 'string') out.description = option.description;
              if (typeof option.recommended === 'boolean') out.recommended = option.recommended;
              return out;
          })
        : null;
    return {
        id: row.id,
        organizationId: row.organizationId ?? null,
        version: Number(row.version) || 1,
        createdAt: isoRequired(row.createdAt),
        updatedAt: isoRequired(row.updatedAt ?? row.createdAt),
        recipientUserId: row.userId,
        kind: row.kind,
        title: row.title,
        body: row.body,
        options,
        sourceType: row.sourceType,
        status: row.status,
        unread: !!row.unread,
        answeredAt: iso(row.answeredAt),
        answerText: row.answerText ?? null,
        answerOptionId: row.answerOptionId ?? null,
        agentId: row.agentId ?? null,
        agentRunId: row.agentRunId ?? null,
        taskId: row.taskId ?? null,
        workId: row.workId ?? null,
        escalationId: row.escalationId ?? null,
        proposalId: row.proposalId ?? null,
        webUrl: webUrl('/inbox'),
    };
}

/**
 * EW-P3-1 — `inbox_item` snapshot. The tenant is the row's own, else its
 * organization's (inbox rows written before tenancy stamping carry only the
 * organization), else `null` (a personal-scope message: recorded for
 * in-process listeners, never served to integrations).
 */
export async function buildInboxItemSnapshot(
    manager: EntityManager,
    id: string,
): Promise<AggregateSnapshot<IntegrationInboxItemDto> | null> {
    const row = await manager.getRepository(InboxItem).findOne({ where: { id } });
    if (!row) return null;
    let tenantId = row.tenantId ?? null;
    if (!tenantId && row.organizationId) {
        const org = await manager
            .getRepository(Organization)
            .findOne({ where: { id: row.organizationId } });
        tenantId = org?.tenantId ?? null;
    }
    return {
        dto: toIntegrationInboxItemDto(row),
        tenantId,
        organizationId: row.organizationId ?? null,
    };
}
