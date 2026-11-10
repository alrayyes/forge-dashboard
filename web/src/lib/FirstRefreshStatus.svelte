<script lang="ts">
  import { firstRefreshStatus } from "#lib/first-refresh.js";
  import { firstRefresh } from "#lib/first-refresh.svelte.js";

  // The one polite status line for the first refresh (#1672). It stays in the
  // page and only its text changes, so a screen reader hears "loading" once
  // and the later "still loading" once, and nothing when the rows arrive.
  // `srOnly` is for pages that draw their own visible loading text (Insights,
  // Webhooks, #3367): the line is still the one live region, but not drawn.
  let { pending, srOnly = false }: { pending: boolean; srOnly?: boolean } =
    $props();

  let elapsed = $state(0);

  $effect(() => {
    if (!pending) {
      elapsed = 0;
      return;
    }
    // Counted from page load, not from when the skeleton appeared.
    const started = firstRefresh.startedAt ?? Date.now();
    const tick = () => {
      elapsed = Date.now() - started;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  });

  const text = $derived(firstRefreshStatus(pending, elapsed));
</script>

<p
  class="first-refresh-status"
  class:active={pending && !srOnly}
  class:sr-only={srOnly}
  role="status"
  aria-live="polite"
  data-testid="first-refresh-status"
>
  {text}
</p>
