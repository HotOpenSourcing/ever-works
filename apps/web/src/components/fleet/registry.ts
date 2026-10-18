import type { ComponentType } from 'react';
import type { FleetNodeView } from '@ever-works/contracts';

/**
 * Fleet UI module registry (README D9, CONTRACTS §11.1) — how an epic adds a
 * computer-page tab, an Overview block or a hub tab without touching another
 * epic's code. Internal and compile-time: entries are registered by plain
 * module imports, and each entry's component is code-split behind `load`.
 *
 * Seam owned by FL-01 (hub & navigation), built by FL-03 with the names
 * CONTRACTS §11.1 fixes (`registerComputerTab`, `registerOverviewBlock`,
 * `registerHubTab`) because FL-03's Overview block landed first. FL-01 adds
 * the placeholder resolution, flag/consent/kind gating and the page shell that
 * renders these lists; it extends this file rather than writing a second one.
 */

/** What every computer-page panel and Overview block receives. */
export interface FleetComputerPanelProps {
    node: FleetNodeView;
}

export interface FleetRegistryEntry<Props = FleetComputerPanelProps> {
    /** Stable id; registering the same id again REPLACES the entry (hot reload, tests). */
    id: string;
    /** i18n key of the label, where the slot shows one (tabs). */
    labelKey?: string;
    /** Ascending sort order within its list. */
    order: number;
    /** The epic that owns the entry, e.g. `FL-03`. */
    epic: string;
    /** Server-side flag that must be on for the entry to show, when it has one. */
    flag?: string;
    /** The code-split component. */
    load: () => Promise<{ default: ComponentType<Props> }>;
}

const computerTabs = new Map<string, FleetRegistryEntry>();
const overviewBlocks = new Map<string, FleetRegistryEntry>();
const hubTabs = new Map<string, FleetRegistryEntry<Record<string, never>>>();

function sorted<T extends { order: number; id: string }>(entries: Iterable<T>): T[] {
    return [...entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** A tab on the computer page (`/fleet/computers/[id]?tab=<id>`). */
export function registerComputerTab(entry: FleetRegistryEntry): void {
    computerTabs.set(entry.id, entry);
}

/** A block on the computer page's Overview tab (metrics, sessions, servers, …). */
export function registerOverviewBlock(entry: FleetRegistryEntry): void {
    overviewBlocks.set(entry.id, entry);
}

/** A tab of the Fleet hub (`/fleet/...`). */
export function registerHubTab(entry: FleetRegistryEntry<Record<string, never>>): void {
    hubTabs.set(entry.id, entry);
}

export function getComputerTabs(): FleetRegistryEntry[] {
    return sorted(computerTabs.values());
}

export function getOverviewBlocks(): FleetRegistryEntry[] {
    return sorted(overviewBlocks.values());
}

export function getHubTabs(): FleetRegistryEntry<Record<string, never>>[] {
    return sorted(hubTabs.values());
}
