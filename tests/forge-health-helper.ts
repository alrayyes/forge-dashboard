// One forge's entry in a mocked `forges` list, with `capabilities` filled in.
//
// A spec that mocks /api/v1/dashboard or the Main branches page builds each
// forge entry here instead of writing it by hand, so a field the schema makes
// required (api/openapi.yaml, ForgeHealth) is added in one place. The
// capabilities come from tests/generated/forge-capabilities.json, which a Go
// test builds from the server's own table and fails on when the table changes
// and the file isn't regenerated.
import table from './generated/forge-capabilities.json';

type Forge = keyof typeof table.forges;

type ForgeHealthOverrides = Record<string, unknown>;

// An up forge with one repository. `over` replaces any field, including
// `capabilities` as a whole, for a spec that states exactly what was answered.
export const forgeHealth = (forge: Forge, over: ForgeHealthOverrides = {}) => ({
  forge,
  reachable: true,
  repoCount: 1,
  capabilities: { ...table.forges[forge] },
  ...over,
});
