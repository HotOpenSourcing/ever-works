import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    AppBuildCancelResponse,
    AppBuildDetail,
    AppBuildListQuery,
    AppBuildListResponse,
    AppBuildPullTokenResponse,
    AppBuildRequestBody,
    AppBuildRequestResponse,
} from '@ever-works/contracts';

/**
 * APW-05 T25 (client half) — server-only client for the Builds routes
 * (`apps/api/src/app-builds/app-builds.controller.ts`, plan §5).
 *
 *   - `GET  /api/works/:id/builds`                  → {@link AppBuildListResponse} (view)
 *   - `GET  /api/works/:id/builds/:buildId`         → {@link AppBuildDetail} (view)
 *   - `POST /api/works/:id/builds`                  → `202` {@link AppBuildRequestResponse} (edit)
 *   - `POST /api/works/:id/builds/:buildId/cancel`  → `202` {@link AppBuildCancelResponse} (edit)
 *   - `PUT  /api/works/:id/builds/pull-token`       → `202` {@link AppBuildPullTokenResponse} (edit)
 *
 * Every shape is the shared contract in `@ever-works/contracts` (`apps/builds.ts`),
 * so the field names cannot drift from the API's. A refusal arrives as a thrown
 * `ApiResponseError` with `statusCode` and the stable `code` intact
 * (`AppBuildApiErrorCode`: `notAppWork`, `buildNotFound`, `rebuildRateLimited` +
 * `retryAfterMinutes`, `commitNotReachable`, `nothingToBuild`, `notCancellable`,
 * `buildProviderUnavailable`, `editAccessRequired`, `appWorksDisabled`, the six
 * `pullToken*` codes) — the caller decides what to say; this client never
 * swallows them.
 *
 * `server-only`, like `work-app-spec.ts`: the Builds page's server component
 * and its server actions call it. The 10-second poll of plan §6.3 needs a
 * same-origin route handler (the shape of `app/api/works/[id]/app-spec/route.ts`)
 * because a poll cannot go through a queued server action — that handler is the
 * UI lane's, and it calls {@link appBuildsAPI.list} / {@link appBuildsAPI.get}.
 *
 * NO leading `/api` in the paths: `serverFetch` / `serverMutation` prepend
 * `API_URL`, which already ends in `/api`.
 */

/** The list query as a query string; arrays are sent comma-separated, as the API accepts them. */
export function appBuildsListQueryString(query: AppBuildListQuery = {}): string {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    const status = Array.isArray(query.status) ? query.status.join(',') : query.status;
    if (status) params.set('status', status);
    const trigger = Array.isArray(query.trigger) ? query.trigger.join(',') : query.trigger;
    if (trigger) params.set('trigger', trigger);
    if (query.branch) params.set('branch', query.branch);
    if (query.pullRequest !== undefined) params.set('pullRequest', String(query.pullRequest));
    const text = params.toString();
    return text ? `?${text}` : '';
}

export const appBuildsAPI = {
    /** `GET /api/works/:id/builds` — one page of Builds plus provider / workflow / pull-token facts. */
    list: async (workId: string, query: AppBuildListQuery = {}): Promise<AppBuildListResponse> => {
        return serverFetch<AppBuildListResponse>(
            `/works/${encodeURIComponent(workId)}/builds${appBuildsListQueryString(query)}`,
        );
    },

    /** `GET /api/works/:id/builds/:buildId` — one Build's drawer. */
    get: async (workId: string, buildId: string): Promise<AppBuildDetail> => {
        return serverFetch<AppBuildDetail>(
            `/works/${encodeURIComponent(workId)}/builds/${encodeURIComponent(buildId)}`,
        );
    },

    /** `POST /api/works/:id/builds` — request a Build (Rebuild); `deduped` within 10 s. */
    request: async (
        workId: string,
        body: AppBuildRequestBody = {},
    ): Promise<AppBuildRequestResponse> => {
        return serverMutation<AppBuildRequestResponse>({
            endpoint: `/works/${encodeURIComponent(workId)}/builds`,
            data: body,
            method: 'POST',
            wrapInData: false,
        });
    },

    /** `POST /api/works/:id/builds/:buildId/cancel` — stop a queued or running Build. */
    cancel: async (workId: string, buildId: string): Promise<AppBuildCancelResponse> => {
        return serverMutation<AppBuildCancelResponse>({
            endpoint: `/works/${encodeURIComponent(workId)}/builds/${encodeURIComponent(buildId)}/cancel`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * `PUT /api/works/:id/builds/pull-token` — save the GHCR pull token.
     *
     * The token travels once, to the API, and is never returned: the answer is
     * the pull access facts. Callers must not log `token` or keep it in state
     * after this resolves (ACC-05-21).
     */
    savePullToken: async (workId: string, token: string): Promise<AppBuildPullTokenResponse> => {
        return serverMutation<AppBuildPullTokenResponse>({
            endpoint: `/works/${encodeURIComponent(workId)}/builds/pull-token`,
            data: { token },
            method: 'PUT',
            wrapInData: false,
        });
    },
};

/** Function-style aliases, for callers that prefer named imports. */
export const listAppBuilds = appBuildsAPI.list;
export const getAppBuild = appBuildsAPI.get;
export const requestAppBuild = appBuildsAPI.request;
export const cancelAppBuild = appBuildsAPI.cancel;
export const saveAppBuildPullToken = appBuildsAPI.savePullToken;
