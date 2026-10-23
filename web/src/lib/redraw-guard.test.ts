import { describe, expect, test } from 'bun:test';
import { createRedrawGuard } from './redraw-guard';

describe('createRedrawGuard', () => {
  test('reports a throw, logs it once per run of failures and clears on success', () => {
    const logged: unknown[] = [];
    const guard = createRedrawGuard((err) => logged.push(err));
    const boom = new Error('boom');
    const fail = () => {
      throw boom;
    };

    expect(guard.run(fail)).toBe(true);
    expect(guard.run(fail)).toBe(true);
    expect(logged).toEqual([boom]);

    expect(guard.run(() => {})).toBe(false);
    expect(guard.run(fail)).toBe(true);
    expect(logged).toEqual([boom, boom]);
  });
});
