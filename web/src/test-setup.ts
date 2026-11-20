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

// bun loads a .svelte.ts module as plain TypeScript, with no Svelte compiler,
// so the $state rune is an undefined name there (#4466). A file that reached
// time.svelte.ts without its own stand-in passed only when another file had
// already mocked the module for the whole process, and failed under the random
// orders that ran it first. A plain value has the same reads and writes, which
// is all a unit test needs from the rune. Defined here, before any test file
// loads, so no order decides.
(globalThis as Record<string, unknown>).$state = <T>(value: T): T => value;
