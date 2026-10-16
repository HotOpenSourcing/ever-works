import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { isDomainEventType } from '@ever-works/contracts';
import { TaskChatController } from '../tasks/task-chat.controller';
import { TaskTemplatesController } from '../task-templates/task-templates.controller';
import { TasksController } from '../tasks/tasks.controller';
import { TeamsController } from '../teams/teams.controller';
import { OrganizationInvitationsController } from '../organizations/organization-invitations.controller';
import { OrganizationsController } from '../organizations/organizations.controller';
import { OrgInviteController } from '../onboarding/org-invite.controller';
import { AgentsController } from '../agents/agents.controller';
import { AgentCollaboratorsController } from '../agents/agent-collaborators.controller';
import { MembersController } from '../works/members.controller';
import { WorksController } from '../works/works.controller';
import { DOMAIN_EVENT_ROUTE_COVERAGE, describeCoverage } from './domain-event-route-coverage';

/**
 * The event-coverage gate (EW-P1-1, spec §3): every mutating route of a
 * controller in the domain-event scope is listed in
 * `DOMAIN_EVENT_ROUTE_COVERAGE` — with the catalog events it records, or the
 * reason it records none. A new POST/PUT/PATCH/DELETE route on one of these
 * controllers fails here until someone decides.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTROLLERS_IN_SCOPE: ReadonlyArray<new (...args: any[]) => unknown> = [
    TasksController,
    TaskChatController,
    TaskTemplatesController,
    TeamsController,
    OrganizationInvitationsController,
    OrgInviteController,
    OrganizationsController,
    AgentsController,
    AgentCollaboratorsController,
    MembersController,
    WorksController,
];

const MUTATING = new Map<number, string>([
    [RequestMethod.POST, 'POST'],
    [RequestMethod.PUT, 'PUT'],
    [RequestMethod.PATCH, 'PATCH'],
    [RequestMethod.DELETE, 'DELETE'],
]);

function joinPath(...parts: Array<string | string[] | undefined>): string {
    const segments = parts
        .flatMap((part) => (Array.isArray(part) ? part[0] : part))
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .map((part) => part.replace(/^\/+|\/+$/g, ''))
        .filter((part) => part.length > 0);
    return `/${segments.join('/')}`;
}

/** Every mutating route of the controllers in scope, as `METHOD /path`. */
function mutatingRoutes(): string[] {
    const routes: string[] = [];
    for (const controller of CONTROLLERS_IN_SCOPE) {
        const base = Reflect.getMetadata(PATH_METADATA, controller) as
            | string
            | string[]
            | undefined;
        const proto = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'constructor') continue;
            const handler = proto[name];
            if (typeof handler !== 'function') continue;
            const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
            const verb = method === undefined ? undefined : MUTATING.get(method);
            if (!verb) continue;
            const path = Reflect.getMetadata(PATH_METADATA, handler) as
                | string
                | string[]
                | undefined;
            routes.push(`${verb} ${joinPath(base, path)}`);
        }
    }
    return routes;
}

describe('domain event route coverage', () => {
    const routes = mutatingRoutes();

    it('finds the routes at all (a silent zero would make the gate useless)', () => {
        expect(routes.length).toBeGreaterThan(20);
        expect(routes).toContain('POST /api/tasks');
        expect(routes).toContain('PATCH /api/task-chat-messages/:id');
    });

    it('lists every mutating route in scope with its events or an exemption', () => {
        const missing = routes.filter((route) => !(route in DOMAIN_EVENT_ROUTE_COVERAGE));
        expect(missing).toEqual([]);
    });

    it('names only catalog types, and gives every exemption a reason', () => {
        for (const [route, coverage] of Object.entries(DOMAIN_EVENT_ROUTE_COVERAGE)) {
            if ('events' in coverage) {
                expect({
                    route,
                    unknown: coverage.events.filter((type) => !isDomainEventType(type)),
                }).toEqual({
                    route,
                    unknown: [],
                });
                expect(coverage.events.length).toBeGreaterThan(0);
            } else {
                expect({ route, reason: coverage.exempt.length > 10 }).toEqual({
                    route,
                    reason: true,
                });
            }
        }
    });

    it('keeps no stale entry for a route that no longer exists', () => {
        const stale = Object.keys(DOMAIN_EVENT_ROUTE_COVERAGE).filter(
            (route) => !routes.includes(route),
        );
        expect(
            stale.map(
                (route) => `${route} (${describeCoverage(DOMAIN_EVENT_ROUTE_COVERAGE[route])})`,
            ),
        ).toEqual([]);
    });
});
