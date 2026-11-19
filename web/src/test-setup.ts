/// <reference types="bun" />
import { beforeEach } from 'bun:test';
import { releaseAllHeld, resetModuleState, resetTouched } from './lib/filters';

// The filters module keeps state between tests: which keys the user touched,
// which saved picks are held back, and the rest of what it remembers (#4215). Test files share it, so one that
// leaves some behind changes what an unrelated file sees, and only under some
// random orders (#4206). Every test starts from none. bunfig.toml names this
// file as a test preload, and test-setup.test.ts pins both.
export function resetFilterState(): void {
  resetTouched();
  releaseAllHeld();
  resetModuleState();
}

beforeEach(resetFilterState);
