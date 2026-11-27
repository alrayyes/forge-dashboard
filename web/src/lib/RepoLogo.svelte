<script lang="ts">
  import { avatarSrc, noteImageFailed } from "#lib/avatar.js";
  import { initialOf } from "#lib/label-filter.js";

  // The repository's own logo when the forge has one, over its initial in the
  // same 16px box, so names line up either way (#3868) and a slow or failed
  // load is never an empty box (#5124). Decorative, since the repository's
  // name sits beside it.
  let {
    forge,
    url,
    name,
  }: { forge: string; url: string | undefined; name: string } = $props();

  // The address each happened to, so a new logo starts afresh.
  let loaded = $state<string | null>(null);
  let failed = $state<string | null>(null);
  const src = $derived(avatarSrc(forge, url));
</script>

<span
  class="repo-logo logo-placeholder"
  class:has-picture={src !== null && loaded === src}
  aria-hidden="true"
  data-initial={initialOf(name.split("/").pop() ?? "")}
>
  {#if src && failed !== src}
    <img
      class="repo-logo"
      {src}
      alt=""
      width="16"
      height="16"
      loading="lazy"
      referrerpolicy="no-referrer"
      onload={() => (loaded = src)}
      onerror={() => {
        noteImageFailed(src);
        failed = src;
      }}
    />
  {/if}
</span>
