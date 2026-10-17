import 'server-only';
import type { AppBuildDetail, AppBuildSummary } from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';
import {
    normalizeAppBuildsList,
    normalizeStartBuildAnswer,
    type AppBuildsList,
    type AppBuildsPullAccess,
} from '@/lib/works/app-builds.shared';

/**
 * APW-05 T25 — the typed client for an App Work's Builds (plan §5).
 *
 * ```
 * GET  /api/works/:id/builds                    list (page, pageSize, status, trigger, branch)
 * GET  /api/works/:id/builds/:buildId           AppBuildDetail
 * POST /api/works/:id/builds                    202 { build, deduped }
 * POST /api/works/:id/builds/:buildId/cancel    202 { build } · 409 notCancellable
 * PUT  /api/works/:id/builds/pull-token         202 { pullAccess } — never returns the token
 * ```
 *
 * The controller ships in the aw-builds lane. Until it is deployed the list
 * answers `404`, which the Builds page renders as a calm "not available on this
 * instance yet" state rather than an error. Refusals keep their stable `code`
 * on the thrown `ApiResponseError` (`rebuildRateLimited`, `commitNotReachable`,
 * `nothingToBuild`, `notCancellable`, `buildProviderUnavailable`, and the
 * `pullToken*` codes), and the web maps each to copy.
 */

/** List filters (plan §5: `page` ≥ 1, `pageSize` 1–100, `status`, `trigger`, `branch`). */
export interface AppBuildsListQuery {
    page?: number;
    pageSize?: number;
    status?: string;
    trigger?: string;
    branch?: string;
}

function listQueryString(query?: AppBuildsListQuery): string {
    if (!query) return '';
    const params = new URLSearchParams();
    if (query.page && query.page >= 1) params.set('page', String(Math.floor(query.page)));
    if (query.pageSize && query.pageSize >= 1) {
        params.set('pageSize', String(Math.min(100, Math.floor(query.pageSize))));
    }
    if (query.status) params.set('status', query.status);
    if (query.trigger) params.set('trigger', query.trigger);
    if (query.branch) params.set('branch', query.branch);
    const text = params.toString();
    return text ? `?${text}` : '';
}

export const appBuildsAPI = {
    /** Every Build of one App Work, newest first, normalised to {@link AppBuildsList}. */
    list: async (workId: string, query?: AppBuildsListQuery): Promise<AppBuildsList> => {
        const raw = await serverFetch<unknown>(
            `/works/${encodeURIComponent(workId)}/builds${listQueryString(query)}`,
        );
        return normalizeAppBuildsList(raw);
    },

    /** One Build's detail — the drawer. */
    get: async (workId: string, buildId: string): Promise<AppBuildDetail> => {
        return serverFetch<AppBuildDetail>(
            `/works/${encodeURIComponent(workId)}/builds/${encodeURIComponent(buildId)}`,
        );
    },

    /** **Start build** — a manual Build of the tracked branch head, or of `commitSha`. */
    start: async (
        workId: string,
        body: { commitSha?: string } = {},
    ): Promise<{ build: AppBuildSummary | null; buildId: string | null; deduped: boolean }> => {
        const raw = await serverMutation<unknown>({
            endpoint: `/works/${encodeURIComponent(workId)}/builds`,
            method: 'POST',
            data: body.commitSha ? { commitSha: body.commitSha } : {},
            wrapInData: false,
        });
        return normalizeStartBuildAnswer(raw);
    },

    /** **Cancel** a queued or running Build. */
    cancel: async (workId: string, buildId: string): Promise<{ build: AppBuildSummary | null }> => {
        const raw = await serverMutation<unknown>({
            endpoint: `/works/${encodeURIComponent(workId)}/builds/${encodeURIComponent(buildId)}/cancel`,
            method: 'POST',
            data: {},
            wrapInData: false,
        });
        return { build: normalizeStartBuildAnswer(raw).build };
    },

    /**
     * Save the image pull token (plan §4.12, `APW05-G07`). Write-only: the answer
     * carries the pull-access state and never the token.
     */
    savePullToken: async (
        workId: string,
        token: string,
    ): Promise<{ pullAccess: AppBuildsPullAccess | null }> => {
        const raw = await serverMutation<unknown>({
            endpoint: `/works/${encodeURIComponent(workId)}/builds/pull-token`,
            method: 'PUT',
            data: { token },
            wrapInData: false,
        });
        return { pullAccess: normalizeAppBuildsList(raw).pullAccess };
    },
};

/**
 * The Overview card's first paint: the newest page of Builds, or `null` when the
 * list cannot be read (route not deployed, a refusal, a network error). Never
 * throws — the Overview must not turn an unreadable Builds list into an error
 * page.
 */
export async function listLatestAppBuilds(workId: string): Promise<AppBuildSummary[] | null> {
    try {
        const list = await appBuildsAPI.list(workId, { pageSize: 20 });
        return list.items;
    } catch {
        return null;
    }
}
