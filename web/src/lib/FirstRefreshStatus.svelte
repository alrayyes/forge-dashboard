<script lang="ts">
  import { firstRefreshStatus } from "#lib/first-refresh.js";

  // The one polite status line for the first refresh (#1672). It stays in the
  // page and only its text changes, so a screen reader hears "loading" once
  // and the later "still loading" once, and nothing when the rows arrive.
  let { pending }: { pending: boolean } = $props();

  let elapsed = $state(0);

  $effect(() => {
    if (!pending) {
      elapsed = 0;
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      elapsed = Date.now() - started;
    }, 1000);
    return () => clearInterval(timer);
  });

  const text = $derived(firstRefreshStatus(pending, elapsed));
</script>

<p
  class="first-refresh-status"
  class:active={pending}
  role="status"
  aria-live="polite"
  data-testid="first-refresh-status"
>
  {text}
</p>
