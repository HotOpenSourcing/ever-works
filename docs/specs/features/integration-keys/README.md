# Integration keys and the integration principal (EW-P1-2)

Scoped, organization-pinned API keys (`ew_int_…`) for server-to-server integrations such as Ever Gauzy, and the
**integration principal** they authenticate as: org-wide reads within its pins, act-as attribution on writes, its own
throttle tier, and no access to key management, account, security, billing or Ever ID admin routes.

- [spec.md](./spec.md) — feature specification
- [plan.md](./plan.md) — implementation plan
- [tasks.md](./tasks.md) — task breakdown

Builds on [`api-keys`](../api-keys/spec.md) (personal `ew_live_` keys, unchanged). Used by every route of
[`integrations-api-v1`](../integrations-api-v1/README.md); surfaced in the UI by
[`integrations-ever-gauzy`](../integrations-ever-gauzy/README.md).

Plan of record: _Gauzy ↔ Ever Works integration plan_ (2026-10-15), private `ever-co/homelab` repo,
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/` — decision D1, 02 §2–3 (this feature), 07 EW-P1-2.
