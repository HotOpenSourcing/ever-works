/**
 * Fleet "needs a look" (CONTRACTS §4.6, R-23) — the one shape every
 * producer emits and the hub renders: a computed list of things on the
 * owner's computers that want a person's attention, each with at most one
 * action. Not a table: items are derived on read from facts the platform
 * already stores, so an item disappears the moment its condition does.
 *
 * Seam owned by FL-01 (hub & navigation), built by FL-03 at the path and
 * with the export names of FL-01's plan (§4.3) because FL-03's producers
 * landed first. FL-01 extends this file; it does not write a second one.
 *
 * Producers: FL-03 (disk-low, node-throttled, node-quarantined,
 * consent-missing, helper-untrusted), FL-02, FL-05, FL-13, FL-17, FL-18
 * (job-unassignable). FL-01 renders.
 */

/** Every kind a producer may emit (CONTRACTS §4.6, revision 4). Closed: a new kind is a contract change. */
export type NeedsALookKind =
	| 'disk-low'
	| 'node-throttled'
	| 'node-quarantined'
	| 'node-upgrade-required'
	| 'runner-stopped'
	| 'job-unassignable'
	| 'session-needs-you'
	| 'session-unconfirmed'
	| 'service-failed'
	| 'schedule-failed'
	| 'cloud-idle'
	| 'helper-untrusted'
	| 'consent-missing';

export const NEEDS_A_LOOK_KINDS: readonly NeedsALookKind[] = [
	'disk-low',
	'node-throttled',
	'node-quarantined',
	'node-upgrade-required',
	'runner-stopped',
	'job-unassignable',
	'session-needs-you',
	'session-unconfirmed',
	'service-failed',
	'schedule-failed',
	'cloud-idle',
	'helper-untrusted',
	'consent-missing'
];

export type NeedsALookSeverity = 'info' | 'warn' | 'critical';

export const NEEDS_A_LOOK_SEVERITIES: readonly NeedsALookSeverity[] = ['info', 'warn', 'critical'];

/** A platform call an item's button makes. Closed set; each maps to an existing, audited route. */
export type NeedsALookOperation =
	/** `POST /api/fleet/nodes/:id/clear-model-throttle`; no provider = every CLI. */
	{ kind: 'clear-model-throttle'; provider?: string };

/**
 * An item's single action (CONTRACTS §4.6 `action?: { label, route|command }`).
 * Exactly one of `route`, `command` or `operation` is set.
 */
export interface NeedsALookAction {
	/** English button text — what an Agent, MCP or the CLI shows. */
	label: string;
	/** i18n leaf under `fleet.needsALook.actions` for the web's localised button. */
	labelKey?: string;
	/** An in-app route to open (CONTRACTS §11.1). */
	route?: string;
	/** A command the owner runs ON the machine; the surface offers a copy button, never a run button. */
	command?: string;
	/** A platform call the button makes. */
	operation?: NeedsALookOperation;
}

export interface NeedsALookItem {
	/**
	 * Stable for the same condition on the same computer (FR-17):
	 * `<kind>:<nodeId>` plus a qualifier when one computer can have two of a
	 * kind. Surfaces dedupe on it.
	 */
	id: string;
	nodeId: string;
	nodeName: string;
	severity: NeedsALookSeverity;
	kind: NeedsALookKind;
	/** English sentence — the rendering Agents, MCP and the CLI show. */
	title: string;
	/** English supporting line, or null. */
	detail: string | null;
	/**
	 * i18n leaf under `fleet.needsALook.kinds` and the values it
	 * interpolates, so the web renders `title` in the viewer's language.
	 * Optional: a producer without a key is shown by its English title.
	 */
	messageKey?: string;
	params?: Record<string, string | number | null>;
	action?: NeedsALookAction;
	/** ISO instant the condition began, as far as the platform knows it; stable across renders. */
	since: string;
}

const SEVERITY_RANK: Record<NeedsALookSeverity, number> = { critical: 0, warn: 1, info: 2 };

/**
 * The one order every surface shows: most severe first, then the
 * longest-standing, then by computer name and id so equal items never
 * swap places between renders.
 */
export function sortNeedsALook(items: readonly NeedsALookItem[]): NeedsALookItem[] {
	return [...items].sort((a, b) => {
		const severity = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
		if (severity !== 0) return severity;
		const since = (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0);
		if (since !== 0) return since;
		const name = a.nodeName.localeCompare(b.nodeName);
		if (name !== 0) return name;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}
