import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../../messages/en.json';
import type { AppsCatalogBlueprintItem } from '@/lib/api/apps-catalog.types';

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));
vi.mock('@/app/actions/dashboard/apps-catalog', () => ({
    listAppsCatalogBlueprintsAction: listMock,
}));

import { APPS_CATALOG_SEARCH_DEBOUNCE_MS, AppsCatalogBrowser } from './AppsCatalogBrowser';

const UMAMI: AppsCatalogBlueprintItem = {
    id: 'umami',
    name: 'Umami',
    summary: 'Privacy-friendly analytics',
    repo: 'ever-works/umami-template',
    url: 'https://github.com/ever-works/umami-template',
    stars: 7,
    spdx: 'MIT',
    topics: ['ever-works-app-blueprint'],
};

function renderBrowser(onPick = vi.fn()) {
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <AppsCatalogBrowser onPick={onPick} />
        </NextIntlClientProvider>,
    );
    return onPick;
}

async function flush(ms = 0) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    listMock.mockReset();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('AppsCatalogBrowser', () => {
    it('lists the Blueprints at once and hands a pick to the form', async () => {
        listMock.mockResolvedValue({
            success: true,
            data: { items: [UMAMI], total: 1, available: true, source: 'github-topic' },
        });
        const onPick = renderBrowser();
        await flush();
        expect(listMock).toHaveBeenCalledWith(undefined);
        const card = screen.getByTestId('apps-catalog-card');
        expect(card.getAttribute('data-blueprint-id')).toBe('umami');
        expect(card.textContent).toContain('ever-works/umami-template · MIT');
        fireEvent.click(card);
        expect(onPick).toHaveBeenCalledWith(UMAMI);
    });

    it('searches only from two characters, after the debounce', async () => {
        listMock.mockResolvedValue({
            success: true,
            data: { items: [], total: 0, available: true, source: 'github-topic' },
        });
        renderBrowser();
        await flush();
        expect(listMock).toHaveBeenCalledTimes(1);

        fireEvent.change(screen.getByTestId('apps-catalog-search'), { target: { value: 'u' } });
        await flush(APPS_CATALOG_SEARCH_DEBOUNCE_MS);
        expect(listMock).toHaveBeenLastCalledWith(undefined);

        fireEvent.change(screen.getByTestId('apps-catalog-search'), { target: { value: 'um' } });
        await flush(APPS_CATALOG_SEARCH_DEBOUNCE_MS - 1);
        expect(listMock).not.toHaveBeenLastCalledWith('um');
        await flush(1);
        expect(listMock).toHaveBeenLastCalledWith('um');
        expect(screen.getByTestId('apps-catalog-empty').textContent).toBe(
            'No apps match your search.',
        );
    });

    it('says when the catalog cannot be read, and when App Works are off', async () => {
        listMock.mockResolvedValueOnce({
            success: true,
            data: { items: [], total: 0, available: false, source: 'github-topic' },
        });
        renderBrowser();
        await flush();
        expect(screen.getByTestId('apps-catalog-unavailable')).toBeTruthy();
        cleanup();

        listMock.mockResolvedValueOnce({
            success: false,
            error: 'x',
            code: 'app_works_disabled',
            httpStatus: 400,
        });
        renderBrowser();
        await flush();
        expect(screen.getByTestId('apps-catalog-disabled').textContent).toBe(
            'App Works are not available on this instance.',
        );
    });
});
