<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import axe from "axe-core";
  import { expect, fn, userEvent } from "storybook/test";
  import WaitChipSwap from "./WaitChipSwap.svelte";

  // MOCKUP for #4942 (nothing in the app draws this yet): the armed-wait chip
  // and the Update branch button sharing one slot. The owner approves it here
  // before the wiring lands. Read the stories in this order: Idle, Hover
  // preview, Keyboard focus, Pressed, Locked, In flight, then the rows.
  //
  //  - Idle shows "Waiting for CI" with Cancel auto-merge, as the chip does.
  //  - Mouse hover previews the swap. Keyboard focus shows the same swap.
  //  - A first touch tap shows it too; a second tap runs. Enter, Space and a
  //    screen reader's click run at once. Hover is never the only way (#4531).
  //  - The slot keeps the chip's 44px height; its width is its widest label.
  //  - Cancel auto-merge is its own button in every state.
  //  - One accessible name, "Waiting for CI, update branch", in every state.
  //    The reason is its description, and one status line speaks per action.
  const { Story } = defineMeta({
    title: "WaitChipSwap",
    component: WaitChipSwap,
  });

  // The stylesheet's dark tokens hang on the root's data-theme.
  function theme(value: "light" | "dark") {
    const root = document.documentElement;
    const before = root.getAttribute("data-theme");
    root.setAttribute("data-theme", value);

    return () => {
      if (before === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", before);
    };
  }

  const swap = (el: HTMLElement) =>
    el.querySelector<HTMLButtonElement>("button.swap") as HTMLButtonElement;

  async function expectNoViolations(el: HTMLElement) {
    const { violations } = await axe.run(el);
    await expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }

  // The same height whatever it says, so the row never reflows.
  async function expectFootprint(el: HTMLElement) {
    const slot = el.querySelector(".slot") as HTMLElement;
    await expect(slot.getBoundingClientRect().height).toBe(44);
  }
</script>

{#snippet row(
  width: number,
  phase: "idle" | "locked" | "inflight",
  reveal: boolean,
)}
  <!-- A pull request row cut down to what decides the width: the title with
       its #4789 floor, the CI pill, a comment pill and the shared slot. -->
  <div class="row" style="width: {width}px">
    <span class="title">chore(deps): update dependency vite to v8.1.0</span>
    <span class="pill">Passed</span>
    <span class="pill">3 comments</span>
    <div class="slotcell">
      <WaitChipSwap {phase} forceReveal={reveal} />
    </div>
  </div>
{/snippet}

<Story
  name="Idle"
  play={async ({ canvasElement }) => {
    await expect(swap(canvasElement).textContent).toContain("Waiting for CI");
    await expectFootprint(canvasElement);
    await expectNoViolations(canvasElement);
  }}
/>

<!-- Mouse hover preview, drawn without a pointer so it can be reviewed. -->
<Story
  name="Hover preview"
  args={{ forceReveal: true }}
  play={async ({ canvasElement }) => {
    await expect(swap(canvasElement).textContent).toContain("Update branch");
    await expectFootprint(canvasElement);
  }}
/>

<!-- Tab onto the control: the same swap, no mouse needed. -->
<Story
  name="Keyboard focus"
  play={async ({ canvasElement }) => {
    await userEvent.tab();
    await expect(document.activeElement).toBe(swap(canvasElement));
    await expect(swap(canvasElement).textContent).toContain("Update branch");
    await expectFootprint(canvasElement);
  }}
/>

<!-- Enter on the focused control runs Update branch at once. A second Tab
     reaches Cancel auto-merge. -->
<Story
  name="Keyboard runs and cancels"
  args={{ onupdate: fn(), oncancel: fn() }}
  play={async ({ canvasElement, args }) => {
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await expect(args.onupdate).toHaveBeenCalledTimes(1);
    await userEvent.tab();
    await userEvent.keyboard(" ");
    await expect(args.oncancel).toHaveBeenCalledTimes(1);
    await expectFootprint(canvasElement);
  }}
/>

<!-- The pressed look, while the button is held. -->
<Story name="Pressed" args={{ forceReveal: true, forceActive: true }} />

<!-- A touch tap, no hover: the first tap reveals, the second runs. -->
<Story
  name="Touch tap twice"
  args={{ onupdate: fn() }}
  play={async ({ canvasElement, args }) => {
    const button = swap(canvasElement);
    // A touch tap's click carries detail 1; button.click() would carry 0.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await expect(args.onupdate).not.toHaveBeenCalled();
    await expect(button.textContent).toContain("Update branch");
    await userEvent.click(button);
    await expect(args.onupdate).toHaveBeenCalledTimes(1);
  }}
/>

<!-- Locked (#4929): the control stays focusable and says why. -->
<Story
  name="Locked"
  args={{ phase: "locked", forceReveal: true }}
  play={async ({ canvasElement }) => {
    await expect(swap(canvasElement).getAttribute("aria-disabled")).toBe(
      "true",
    );
    await expectFootprint(canvasElement);
    await expectNoViolations(canvasElement);
  }}
/>

<!-- Update branch running: no swap, no second run, Cancel still there. -->
<Story
  name="In flight"
  args={{ phase: "inflight" }}
  play={async ({ canvasElement }) => {
    await expect(swap(canvasElement).getAttribute("aria-busy")).toBe("true");
    await expect(swap(canvasElement).textContent).toContain("Updating branch");
    await expectFootprint(canvasElement);
    await expectNoViolations(canvasElement);
  }}
/>

<Story name="Row 1280px, light" asChild beforeEach={() => theme("light")}>
  {@render row(1280, "idle", false)}
  {@render row(1280, "idle", true)}
</Story>

<Story name="Row 1280px, dark" asChild beforeEach={() => theme("dark")}>
  {@render row(1280, "idle", false)}
  {@render row(1280, "idle", true)}
  {@render row(1280, "locked", true)}
  {@render row(1280, "inflight", false)}
</Story>

<Story name="Row 390px, light" asChild beforeEach={() => theme("light")}>
  {@render row(390, "idle", false)}
  {@render row(390, "idle", true)}
</Story>

<Story name="Row 390px, dark" asChild beforeEach={() => theme("dark")}>
  {@render row(390, "idle", false)}
  {@render row(390, "idle", true)}
  {@render row(390, "locked", true)}
  {@render row(390, "inflight", false)}
</Story>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    max-width: 100%;
    margin-bottom: 12px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--ink);
    font-size: 0.8125rem;
    overflow: hidden;
  }
  .title {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill {
    flex: none;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--neutral-bg);
    color: var(--ink-2);
    font-size: 0.71875rem;
    white-space: nowrap;
  }
  .slotcell {
    flex: none;
  }
  @media (width <= 760px) {
    .row {
      flex-wrap: wrap;
    }
    .title {
      flex-basis: 100%;
    }
    .slotcell {
      flex: 1 1 100%;
    }
  }
</style>
