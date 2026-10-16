/**
 * Integration DTOs (integration contract v1, B.6) — the shapes an integration
 * reads from `/api/integrations/v1` and the `data` of domain events.
 *
 * TypeScript mirror of the published JSON Schemas in
 * `docs/specs/features/integrations-api-v1/contract/schemas/resources/`. An
 * event's `data` and a GET of the same aggregate version are built by the same
 * mapper, so they are identical.
 *
 * Every timestamp is an ISO-8601 UTC string; every id a uuid string.
 */

export type IntegrationVisibility = 'team' | 'organization';

export interface IntegrationActorRef {
	readonly type: 'user' | 'agent' | 'integration' | 'system';
	readonly id: string;
	readonly label?: string | null;
}

export interface IntegrationOwnerRef {
	readonly type: 'user' | 'agent' | 'integration';
	readonly id: string;
}

export interface IntegrationExternalLink {
	readonly source: string;
	readonly installationId?: string | null;
	readonly externalId: string;
	readonly externalUrl?: string | null;
}

/** Fields every versioned DTO carries. */
export interface IntegrationResourceBase {
	readonly id: string;
	readonly organizationId: string;
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly visibility: IntegrationVisibility;
	readonly visibilityExplicit: boolean;
	readonly owner: IntegrationOwnerRef;
	readonly createdBy: IntegrationActorRef;
	readonly externalLinks: readonly IntegrationExternalLink[];
	/** Only on `*.deleted` event data. */
	readonly deleted?: true;
}

export interface IntegrationOrganizationDto {
	readonly id: string;
	readonly tenantId: string;
	readonly slug: string;
	readonly displayName: string;
	readonly legalName?: string | null;
	readonly countryCode?: string | null;
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly webUrl?: string | null;
}

export interface IntegrationMemberDto {
	readonly organizationId: string;
	readonly userId: string;
	readonly username: string;
	readonly displayName?: string | null;
	readonly email: string | null;
	readonly emailVerified: boolean;
	readonly avatarUrl: string | null;
	readonly role: string;
	readonly isActive?: boolean;
	readonly joinedAt: string;
	readonly updatedAt: string;
	readonly everIdSubjects: readonly { readonly issuer: string; readonly subject: string }[];
	readonly deleted?: true;
}

export interface IntegrationAgentDto extends IntegrationResourceBase {
	readonly teamIds: readonly string[];
	readonly name: string;
	readonly slug: string;
	readonly title?: string | null;
	readonly capabilities?: string | null;
	readonly status: 'draft' | 'active' | 'running' | 'paused' | 'error' | 'archived';
	readonly scope: 'tenant' | 'mission' | 'idea' | 'work';
	readonly scopeTargetId: string;
	readonly reportsToAgentId?: string | null;
	readonly avatar: {
		readonly mode: 'initials' | 'icon' | 'image';
		readonly icon?: string | null;
		readonly url?: string | null;
	};
	readonly modelId?: string | null;
	readonly lastRunAt?: string | null;
	readonly webUrl?: string | null;
}

export interface IntegrationTeamMemberRef {
	readonly memberType: 'user' | 'agent';
	readonly memberId: string;
	readonly role: 'lead' | 'member';
}

export interface IntegrationTeamResourceRef {
	readonly resourceType: string;
	readonly resourceId: string;
}

export interface IntegrationTeamDto extends IntegrationResourceBase {
	readonly visibility: 'organization';
	readonly visibilityExplicit: false;
	readonly name: string;
	readonly slug: string;
	readonly description?: string | null;
	readonly parentTeamId?: string | null;
	readonly managerAgentId?: string | null;
	readonly avatarIcon?: string | null;
	readonly members: readonly IntegrationTeamMemberRef[];
	readonly resources: readonly IntegrationTeamResourceRef[];
	readonly webUrl?: string | null;
}

/** `data` of `team.member.*`. */
export interface IntegrationTeamMemberEventData extends IntegrationTeamMemberRef {
	readonly teamId: string;
	readonly deleted?: true;
}

/** `data` of `team.resource.*`. */
export interface IntegrationTeamResourceEventData extends IntegrationTeamResourceRef {
	readonly teamId: string;
	readonly deleted?: true;
}

export type IntegrationWorkMemberRole = 'owner' | 'manager' | 'editor' | 'viewer';

export interface IntegrationWorkDto extends IntegrationResourceBase {
	readonly visibilityExplicit: false;
	readonly teamIds: readonly string[];
	readonly name: string;
	readonly slug: string;
	readonly description?: string | null;
	readonly kind: string;
	readonly status: 'draft' | 'active' | 'registered' | 'archived';
	readonly website?: string | null;
	readonly repoUrls: readonly string[];
	readonly members: readonly { readonly userId: string; readonly role: IntegrationWorkMemberRole }[];
	readonly webUrl?: string | null;
}

/** `data` of `work.member.*`. */
export interface IntegrationWorkMemberEventData {
	readonly workId: string;
	readonly userId: string;
	readonly role: IntegrationWorkMemberRole;
	readonly deleted?: true;
}

export type IntegrationTaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';

export interface IntegrationPrincipalRef {
	readonly type: 'user' | 'agent';
	readonly id: string;
}

export interface IntegrationTaskDto extends IntegrationResourceBase {
	readonly teamIds: readonly string[];
	readonly slug: string;
	readonly title: string;
	readonly description: string | null;
	readonly status: IntegrationTaskStatus;
	readonly priority: 'p0' | 'p1' | 'p2' | 'p3' | 'p4';
	readonly labels: readonly string[];
	readonly workId: string | null;
	readonly missionId: string | null;
	readonly ideaId: string | null;
	readonly goalId: string | null;
	readonly agentId: string | null;
	readonly parentTaskId: string | null;
	readonly assignees: readonly IntegrationPrincipalRef[];
	readonly watchers: readonly string[];
	readonly approvers: readonly (IntegrationPrincipalRef & { readonly state: 'pending' | 'approved' | 'rejected' })[];
	readonly reviewers: readonly (IntegrationPrincipalRef & {
		readonly state: 'pending' | 'requested-changes' | 'approved';
	})[];
	readonly blockedBy: readonly string[];
	readonly relations: readonly { readonly taskId: string; readonly kind: 'related' | 'duplicates' | 'follow-up' }[];
	readonly startedAt?: string | null;
	readonly completedAt?: string | null;
	readonly isRecurringTemplate?: boolean;
	readonly hiddenFromBoard?: boolean;
	readonly runtime: {
		readonly prUrl: string | null;
		readonly prState: string | null;
		readonly ciState: string | null;
		readonly latestRunStatus: string | null;
	};
	readonly webUrl: string | null;
	/** P2 (EW-P2-3). */
	readonly dueAt?: string | null;
	readonly startAt?: string | null;
	readonly estimateMinutes?: number | null;
}

export interface IntegrationTaskCommentDto {
	readonly id: string;
	readonly taskId: string;
	readonly organizationId: string;
	readonly authorType: 'user' | 'agent' | 'integration';
	readonly authorId: string;
	readonly externalAuthor?: {
		readonly name: string;
		readonly avatarUrl?: string | null;
		readonly source?: string;
	} | null;
	readonly body: string;
	readonly mentions: readonly {
		readonly type: 'user' | 'agent' | 'kb';
		readonly id?: string | null;
		readonly slug?: string | null;
	}[];
	readonly editedAt: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly externalLinks: readonly IntegrationExternalLink[];
	readonly deleted?: true;
}

/** `data` of `task.assignee.*`. */
export interface IntegrationTaskAssigneeEventData extends IntegrationPrincipalRef {
	readonly taskId: string;
	readonly deleted?: true;
}

/** `data` of `task.watcher.*`. */
export interface IntegrationTaskWatcherEventData {
	readonly taskId: string;
	readonly userId: string;
	readonly deleted?: true;
}

/** `data` of `task.block.*`: `blockedByTaskId` blocks `taskId`. */
export interface IntegrationTaskBlockEventData {
	readonly taskId: string;
	readonly blockedByTaskId: string;
	readonly deleted?: true;
}

/** `data` of `task.relation.*`. */
export interface IntegrationTaskRelationEventData {
	readonly taskId: string;
	readonly relatedTaskId: string;
	readonly kind: 'related' | 'duplicates' | 'follow-up';
	readonly deleted?: true;
}

/** `data` of `<aggregate>.visibility_changed` when the record became private. */
export interface IntegrationVisibilityPrivateData {
	readonly id: string;
	readonly visibility: 'private';
}

<<<<<<< HEAD
/**
 * EW-P3-1 — one Inbox message addressed to ONE human (its recipient): a
 * question an agent run asked, an approval request, an escalation mirror or a
 * system notice. The `data` of `inbox.item.*` events and the body of
 * `GET /inbox/items[/:id]`.
 *
 * Not a {@link IntegrationResourceBase}: an inbox item is the recipient's
 * message, not an organization resource — it has no owner, visibility, team or
 * external links. `organizationId` is null for a message outside any
 * organization (such items never reach an integration). Fleet provenance
 * (`sourceMeta`: node names, branches, mount directories) is deliberately not
 * exposed.
 */
export interface IntegrationInboxItemDto {
	readonly id: string;
	readonly organizationId: string | null;
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** The human the message is for; replies and state changes act as this user only. */
	readonly recipientUserId: string;
	readonly kind: 'question' | 'approval' | 'escalation' | 'notice';
	readonly title: string;
	readonly body: string;
	readonly options:
		| readonly {
				readonly id: string;
				readonly label: string;
				readonly description?: string;
				readonly recommended?: boolean;
		  }[]
		| null;
	/** Which producer filed it (open set: agent-run, fleet-run, escalation, proposal, system, work). */
	readonly sourceType: string;
	readonly status: 'open' | 'answered' | 'archived';
	readonly unread: boolean;
	readonly answeredAt: string | null;
	readonly answerText: string | null;
	readonly answerOptionId: string | null;
	readonly agentId: string | null;
	readonly agentRunId: string | null;
	readonly taskId: string | null;
	readonly workId: string | null;
	readonly escalationId: string | null;
	readonly proposalId: string | null;
	readonly webUrl?: string | null;
	/** Only on `inbox.item.deleted`. */
	readonly deleted?: true;
=======
/** Lifecycle of an Idea (Ever Works `work_proposals.status`). */
export type IntegrationIdeaStatus = 'pending' | 'dismissed' | 'accepted' | 'queued' | 'building' | 'failed';

/** Where an Idea came from; integration creates are always `external` (EW-P2-1). */
export type IntegrationIdeaSource =
	| 'auto-signup'
	| 'user-refresh'
	| 'discover'
	| 'scheduled'
	| 'user-manual'
	| 'mission'
	| 'external';

/**
 * Idea DTO (B.6, `GET /ideas`, `GET /ideas/:id`) and the `data` of `idea.*` events.
 * An integration creates Ideas `pending` with `source = 'external'` and never builds
 * them (spend safety D9): building stays a user action in Ever Works.
 */
export interface IntegrationIdeaDto extends IntegrationResourceBase {
	readonly teamIds: readonly string[];
	readonly title: string;
	readonly description: string;
	readonly status: IntegrationIdeaStatus;
	readonly source: IntegrationIdeaSource;
	readonly missionId: string | null;
	readonly targetWorkId: string | null;
	readonly acceptedWorkId: string | null;
	readonly failureMessage: string | null;
	readonly webUrl?: string | null;
>>>>>>> 5e264b7b2e9f49e2dca8724e9353779a2884db58
}
