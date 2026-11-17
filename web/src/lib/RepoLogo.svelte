<script lang="ts">
  import { avatarSrc } from "#lib/avatar.js";
  import { initialOf } from "#lib/label-filter.js";

  // The repository's own logo when the forge has one, else its initial in the
  // same 16px box, so names line up either way (#3868). Decorative, since the
  // repository's name sits beside it. A failed load shows the initial.
  let { url, name }: { url: string | undefined; name: string } = $props();

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
{:else}
  <span
    class="repo-logo logo-placeholder"
    aria-hidden="true"
    data-initial={initialOf(name.split("/").pop() ?? "")}
  ></span>
{/if}
