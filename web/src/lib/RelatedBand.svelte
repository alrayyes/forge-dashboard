<script lang="ts">
  import { patchPills } from "./patch-pills";
  import type { RelatedBandData } from "./related-band";
  let { band }: { band: RelatedBandData } = $props();

  // Mounts a row's pills. When the page hands over another draw of the same
  // pills, the ones that read differently are written where they stand, so
  // focus and the pointer's place stay (#4328); any other set replaces them.
  function mount(host: HTMLElement, node: HTMLElement) {
    host.replaceChildren(node);
    return {
      update(next: HTMLElement) {
        const shown = host.firstElementChild;
        if (shown === next) return;
        if (shown instanceof HTMLElement && patchPills(shown, next)) return;
        host.replaceChildren(next);
      },
    };
  }
</script>

{#if band.rows.length > 0}
  <section class="related-band" aria-labelledby="related-band-title">
    <div class="related-head">
      <h3 id="related-band-title" class="related-title">Related</h3>
      <span class="related-count">{band.count}</span>
    </div>
    {#each band.rows as row (row.key)}
      <div class="related-row" role="group" aria-label={row.label}>
        <span class="related-label">{row.label}</span>
        <div class="related-pills">
          <div class="related-host" use:mount={row.node}></div>
        </div>
      </div>
    {/each}
  </section>
{/if}

<style>
  /* Metadata between the title block and the description: sunken, with a
     bottom border. No overflow clipping and a little padding, so a pill's
     2px focus ring and offset are never cropped. */
  .related-band {
    flex: none;
    padding: 10px 18px 12px;
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--border);
  }
  .related-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }
  .related-title {
    margin: 0;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-2);
  }
  .related-count {
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--ink-2);
  }
  .related-row {
    display: grid;
    grid-template-columns: 7.5rem minmax(0, 1fr);
    align-items: start;
    gap: 4px 12px;
    padding: 3px 4px;
  }
  .related-row + .related-row {
    margin-top: 2px;
  }
  .related-label {
    padding-top: 3px;
    font-size: 0.78125rem;
    color: var(--ink-2);
  }
  .related-pills {
    min-width: 0;
  }
  /* The row builders' pills, drawn here as they are on a row, at the band's
     size: 26px tall (24px is the floor), a gap that holds wrapped lines apart,
     and a surface fill on the sunken band. Every relation looks alike; the
     row's label names it. */
  .related-host :global(.linked-prs) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 6px;
  }
  .related-host :global(.linked-pr),
  .related-host :global(.linked-pr-more) {
    box-sizing: border-box;
    min-height: 26px;
    align-items: center;
    padding: 2px 10px;
    font-size: 0.78125rem;
    background: var(--surface);
  }
  .related-host :global(.linked-pr) {
    max-width: 100%;
  }
  /* The disclosure is text with a chevron, not an entity-shaped pill. */
  .related-host :global(.related-toggle) {
    background: transparent;
    border-color: transparent;
    color: var(--ink-2);
    text-decoration: underline;
    gap: 4px;
    display: inline-flex;
  }
  .related-host :global(.related-chevron) {
    display: inline-block;
    width: 0.4em;
    height: 0.4em;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(45deg) translateY(-0.1em);
  }
  .related-host
    :global(.related-toggle[aria-expanded="true"] .related-chevron) {
    transform: rotate(-135deg);
  }
  @media (max-width: 480px) {
    /* The label stacks above its pills. */
    .related-row {
      grid-template-columns: minmax(0, 1fr);
    }
    .related-label {
      padding-top: 0;
    }
  }
</style>
