<script lang="ts">
  import { SETTINGS_GROUPS, type SettingsGroupId } from "./settings-groups.js";

  let { current }: { current: SettingsGroupId } = $props();
</script>

<nav class="settings-nav" aria-label="Settings groups">
  <ul>
    {#each SETTINGS_GROUPS as g (g.id)}
      <li>
        <a
          href={`#${g.id}`}
          aria-current={current === g.id ? "page" : undefined}
          class:current={current === g.id}
        >
          <span class="label">{g.label}</span>
          <span class="caption">{g.caption}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .settings-nav ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  a {
    display: block;
    min-height: 44px;
    box-sizing: border-box;
    padding: 8px 10px 8px 12px;
    border-left: 3px solid transparent;
    border-radius: 0 6px 6px 0;
    color: var(--ink-2);
    text-decoration: none;
  }
  a:hover {
    background: var(--surface-sunken);
  }
  a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* The current group is the bar and the bold label, not only a colour. */
  a.current {
    border-left-color: var(--accent);
    background: var(--surface-sunken);
    color: var(--ink);
  }
  .label {
    display: block;
    font-size: 14px;
  }
  a.current .label {
    font-weight: 700;
  }
  .caption {
    display: block;
    font-size: 12px;
    color: var(--ink-3);
  }
  @media (max-width: 760px) {
    /* A wrapping row of pills: all five stay on screen, no sideways scroll. */
    .settings-nav ul {
      flex-direction: row;
      flex-wrap: wrap;
      gap: 8px;
    }
    a {
      display: flex;
      align-items: center;
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface);
    }
    a.current {
      border-color: var(--accent);
      border-bottom: 4px solid var(--accent);
      background: var(--surface-sunken);
    }
    .caption {
      display: none;
    }
  }
</style>
