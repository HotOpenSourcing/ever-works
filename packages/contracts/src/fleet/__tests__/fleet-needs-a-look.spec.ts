import { describe, expect, it } from 'vitest';

import { NEEDS_A_LOOK_KINDS, sortNeedsALook, type NeedsALookItem } from '../fleet-needs-a-look.types.js';

function item(overrides: Partial<NeedsALookItem>): NeedsALookItem {
	return {
		id: 'disk-low:n1',
		nodeId: 'n1',
		nodeName: 'build-01',
		severity: 'warn',
		kind: 'disk-low',
		title: 'Disk is 88% full',
		detail: null,
		since: '2026-10-18T09:00:00.000Z',
		...overrides
	};
}

describe('needs a look — shape (CONTRACTS §4.6)', () => {
	it('is the closed set of thirteen kinds (revision 3 adds session-unconfirmed, revision 4 service-failed)', () => {
		expect(NEEDS_A_LOOK_KINDS).toEqual([
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
		]);
	});

	it('sorts most severe first, then longest-standing, then by name and id — never by input order', () => {
		const info = item({ id: 'consent-missing:n3', severity: 'info', nodeName: 'win-lab' });
		const warnOld = item({ id: 'node-throttled:n2', since: '2026-10-18T08:00:00.000Z', nodeName: 'build-02' });
		const warnNewA = item({ id: 'disk-low:n1', nodeName: 'alpha' });
		const warnNewB = item({ id: 'disk-low:n4', nodeName: 'beta' });
		const critical = item({ id: 'node-quarantined:n5', severity: 'critical', since: '2026-10-18T09:30:00.000Z' });
		const expected = [critical, warnOld, warnNewA, warnNewB, info];
		expect(sortNeedsALook([info, warnNewB, warnNewA, critical, warnOld])).toEqual(expected);
		expect(sortNeedsALook([...expected].reverse())).toEqual(expected);
	});

	it('does not mutate its input', () => {
		const input = [item({ severity: 'info' }), item({ id: 'x', severity: 'critical' })];
		const copy = [...input];
		sortNeedsALook(input);
		expect(input).toEqual(copy);
	});
});
