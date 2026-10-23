// Runs a redraw that must not fail the page. Returns true while it throws, and
// reports a run of failures once, not on every poll.
export function createRedrawGuard(report: (err: unknown) => void) {
  let failing = false;
  return {
    run(redraw: () => void): boolean {
      try {
        redraw();
        failing = false;
      } catch (err) {
        if (!failing) report(err);
        failing = true;
      }
      return failing;
    },
  };
}
