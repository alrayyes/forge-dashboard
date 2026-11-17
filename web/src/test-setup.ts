/// <reference types="bun" />
import { beforeEach } from 'bun:test';
import { releaseAllHeld, resetTouched } from './lib/filters';

// The filters module keeps state between tests: which keys the user touched
// and which saved picks are held back. Test files share it, so one that
// leaves some behind changes what an unrelated file sees, and only under some
// random orders (#4206). Every test starts from none.
beforeEach(() => {
  resetTouched();
  releaseAllHeld();
});
