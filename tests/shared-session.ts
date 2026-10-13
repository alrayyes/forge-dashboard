import path from 'node:path';

// One ordinary (non-admin) user that admin-global-setup.ts registers once, for
// specs that only mock /api/dashboard and write no per-user server state. They
// start from this saved session instead of paying for an invite and a passkey
// registration in every test (#1379). A spec that saves settings (theme, filter
// state), tokens or passkeys keeps its own user, because this one is shared by
// every spec that uses it. Not the admin, so the nav and pages look like they
// do for everyone else. The session is saved by global setup, which registers
// the admin first, so it only runs against an empty database: re-running the
// suite against a database that already has users fails there.
export const SHARED_USERNAME = 'shared';
export const SHARED_STORAGE_STATE_PATH = path.join(
  __dirname,
  '.auth',
  'shared.json',
);
