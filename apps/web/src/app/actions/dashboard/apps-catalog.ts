'use server';

import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { appsCatalogAPI } from '@/lib/api/apps-catalog';
import type { AppsCatalogBlueprintList } from '@/lib/api/apps-catalog.types';

/** What the catalog tab reads. `code` passes the API's refusal through (`app_works_disabled`). */
export type AppsCatalogListResult =
    | { success: true; data: AppsCatalogBlueprintList }
    | { success: false; error: string; code?: string; httpStatus?: number };

/**
 * The create form's "Browse the Apps catalog" read (APW-01 T22). A server
 * action is a POST endpoint, so the session is checked here, not only on the API.
 */
export async function listAppsCatalogBlueprintsAction(query?: string): Promise<AppsCatalogListResult> {
    const user = await getAuthFromCookie();
    if (!user) return { success: false, error: 'unauthorized', code: 'unauthorized', httpStatus: 401 };
    try {
        return {
            success: true,
            data: await appsCatalogAPI.listBlueprints(typeof query === 'string' ? query : undefined),
        };
    } catch (error) {
        if (error instanceof ApiResponseError) {
            return { success: false, error: error.message, code: error.code, httpStatus: error.statusCode };
        }
        console.error('Failed to list the Apps catalog:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
