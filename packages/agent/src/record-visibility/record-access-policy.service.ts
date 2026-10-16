import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository, type SelectQueryBuilder, type ObjectLiteral } from 'typeorm';
import {
    normalizeRecordListView,
    type RecordListView,
    type VisibilityAggregate,
} from '@ever-works/contracts';
import { Organization } from '../entities/organization.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { Tenant } from '../entities/tenant.entity';
import { Work } from '../entities/work.entity';
import { WorkMember } from '../entities/work-member.entity';
import type { OwnershipScope } from '../database/ownership-scope';
import type { RecordAccessContext, VisibilityPrincipal } from './record-access.types';
import { visibleToPredicate } from './visible-to';

/** The task participant kinds (spec §3.1). */
export type TaskParticipantKind = 'assignee' | 'approver' | 'reviewer' | 'watcher';

export const ALL_TASK_PARTICIPANT_KINDS: readonly TaskParticipantKind[] = [
    'assignee',
    'approver',
    'reviewer',
    'watcher',
];

/**
 * `RecordAccessPolicy` — who may read, comment on and transition a task, goal,
 * mission, idea or agent (EW-P1-3, `docs/specs/features/record-visibility/spec.md`
 * §3–§4). Ownership is unchanged: owners keep every right they have today, and the
 * `mine` view is exactly today's list. Visibility only ADDS readers.
 *
 * Read: {@link contextFor} resolves the caller's roster, Teams and Works once per
 * request, and {@link applyVisibleTo} composes `visibleTo(principal)` into a query.
 *
 * Write (spec §4): writes stay with the owner and the existing role rules;
 * participants (assignee, approver, reviewer) may transition a task; anyone who can
 * read a task may comment on it.
 */
@Injectable()
export class RecordAccessPolicy {
    constructor(
        @InjectRepository(OrganizationMember)
        private readonly members: Repository<OrganizationMember>,
        @InjectRepository(Organization)
        private readonly organizations: Repository<Organization>,
        @InjectRepository(Tenant)
        private readonly tenants: Repository<Tenant>,
        @InjectRepository(TeamMember)
        private readonly teamMembers: Repository<TeamMember>,
        @InjectRepository(Team)
        private readonly teams: Repository<Team>,
        @InjectRepository(WorkMember)
        private readonly workMembers: Repository<WorkMember>,
        @InjectRepository(Work)
        private readonly works: Repository<Work>,
        @InjectRepository(TaskAssignee)
        private readonly assignees: Repository<TaskAssignee>,
        @InjectRepository(TaskApprover)
        private readonly approvers: Repository<TaskApprover>,
        @InjectRepository(TaskReviewer)
        private readonly reviewers: Repository<TaskReviewer>,
        @InjectRepository(TaskWatcher)
        private readonly watchers: Repository<TaskWatcher>,
    ) {}

    /** Normalize a `?view=` query value; unknown or missing = `mine`. */
    static view(value?: string | null): RecordListView {
        return normalizeRecordListView(value);
    }

    /**
     * Resolve everything the read predicate needs for one request.
     *
     * Personal scope (`organizationId` null) needs nothing: personal rows are always
     * `private`, so reads there stay owner-only.
     */
    async contextFor(
        principal: VisibilityPrincipal,
        scope?: OwnershipScope | null,
    ): Promise<RecordAccessContext> {
        const organizationId = scope?.organizationId ?? null;
        const base: RecordAccessContext = {
            principal,
            organizationId,
            isOrganizationMember: false,
            teamIds: [],
            workIds: [],
        };
        if (principal.kind !== 'user' || !organizationId) return base;

        const [isOrganizationMember, teamIds, workIds] = await Promise.all([
            this.isOrganizationMember(organizationId, principal.userId),
            this.teamIdsFor(organizationId, principal.userId),
            this.workIdsFor(principal.userId),
        ]);
        return { ...base, isOrganizationMember, teamIds, workIds };
    }

    /**
     * The authoritative Organization roster (spec §6): a roster row, or the Tenant
     * owner (a member of every Organization of their Tenant by construction — no row is
     * ever written for them). Also the act-as check for integration writes (EW-P1-2).
     */
    async isOrganizationMember(organizationId: string, userId: string): Promise<boolean> {
        const row = await this.members.findOne({
            where: { organizationId, userId },
            select: { id: true },
        });
        if (row) return true;
        const organization = await this.organizations.findOne({
            where: { id: organizationId },
            select: { id: true, tenantId: true },
        });
        if (!organization?.tenantId) return false;
        const tenant = await this.tenants.findOne({
            where: { id: organization.tenantId },
            select: { id: true, ownerUserId: true },
        });
        return tenant?.ownerUserId === userId;
    }

    /** The Organization's Teams the user is a member of. */
    async teamIdsFor(organizationId: string, userId: string): Promise<string[]> {
        const memberships = await this.teamMembers.find({
            where: { memberType: 'user', memberId: userId },
            select: { id: true, teamId: true },
        });
        if (memberships.length === 0) return [];
        const teams = await this.teams.find({
            where: { id: In([...new Set(memberships.map((m) => m.teamId))]), organizationId },
            select: { id: true },
        });
        return teams.map((team) => team.id);
    }

    /** Works the user owns or is a member of. */
    async workIdsFor(userId: string): Promise<string[]> {
        const [owned, memberOf] = await Promise.all([
            this.works.find({ where: { userId }, select: { id: true } }),
            this.workMembers.find({ where: { userId }, select: { id: true, workId: true } }),
        ]);
        return [...new Set([...owned.map((w) => w.id), ...memberOf.map((m) => m.workId)])];
    }

    /** Compose `visibleTo(principal)` into a query builder whose alias is `alias`. */
    applyVisibleTo<T extends ObjectLiteral>(
        qb: SelectQueryBuilder<T>,
        alias: string,
        aggregate: VisibilityAggregate,
        context: RecordAccessContext,
        view: RecordListView,
        parameterPrefix?: string,
    ): SelectQueryBuilder<T> {
        const predicate = visibleToPredicate({
            alias,
            aggregate,
            context,
            view,
            escape: (identifier) => qb.connection.driver.escape(identifier),
            parameterPrefix,
        });
        return qb.andWhere(predicate.clause, predicate.parameters);
    }

    /** Whether the user takes part in the task as one of `kinds`. */
    async isTaskParticipant(
        taskId: string,
        userId: string,
        kinds: readonly TaskParticipantKind[] = ALL_TASK_PARTICIPANT_KINDS,
    ): Promise<boolean> {
        const checks: Array<Promise<number>> = [];
        if (kinds.includes('assignee')) {
            checks.push(
                this.assignees.count({ where: { taskId, assigneeType: 'user', assigneeId: userId } }),
            );
        }
        if (kinds.includes('approver')) {
            checks.push(
                this.approvers.count({ where: { taskId, approverType: 'user', approverId: userId } }),
            );
        }
        if (kinds.includes('reviewer')) {
            checks.push(
                this.reviewers.count({ where: { taskId, reviewerType: 'user', reviewerId: userId } }),
            );
        }
        if (kinds.includes('watcher')) {
            checks.push(this.watchers.count({ where: { taskId, userId } }));
        }
        const counts = await Promise.all(checks);
        return counts.some((count) => count > 0);
    }
}
