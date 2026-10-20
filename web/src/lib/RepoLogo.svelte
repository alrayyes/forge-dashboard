<script lang="ts">
  import { avatarSrc } from "#lib/avatar.js";

  // The repository's own logo, only when the forge has one: nothing is drawn
  // otherwise, so a row without one doesn't shift. Decorative, since the
  // repository's name sits beside it. A failed load drops the image and
  // leaves the name alone.
  let { url }: { url: string | undefined } = $props();

  let failed = $state(false);
  const src = $derived(avatarSrc(url));
</script>

{#if src && !failed}
  <img
    class="repo-logo"
    {src}
    alt=""
    width="16"
    height="16"
    loading="lazy"
    referrerpolicy="no-referrer"
    onerror={() => (failed = true)}
  />
{/if}
