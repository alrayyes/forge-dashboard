<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, within } from "storybook/test";
  import type { NavCount } from "./nav-counts.svelte.js";
  import NavPills from "./NavPills.svelte";

  const { Story } = defineMeta({
    title: "NavPills",
    component: NavPills,
    // The pill is aria-hidden and always sits inside the nav link, whose own
    // text names it. The decorator-free story renders it on its own, so each
    // story below wraps it the way the layout does.
  });

  // The pill's children, by the kind class each carries after .nav-count.
  function order(canvasElement: HTMLElement): string[] {
    const pill = canvasElement.querySelector(".nav-pills");
    return [...(pill?.children ?? [])].map(
      (c) => [...c.classList].find((n) => n !== "nav-count") ?? "",
    );
  }
</script>

{#snippet inLink(
  count: NavCount | null,
  extra: { stacked?: boolean; pending?: boolean } = {},
)}
  <nav aria-label="Pages">
    <a href="#pull-requests">Pull requests <NavPills {count} {...extra} /></a>
  </nav>
{/snippet}

<!-- Every outcome at once: total, failed, passed, then the running state. -->
<Story
  asChild
  name="All counts"
  play={async ({ canvasElement }) => {
    const pill = canvasElement.querySelector(".nav-pills") as HTMLElement;
    await expect(pill.getAttribute("aria-hidden")).toBe("true");
    await expect(pill.querySelector(".nav-total")?.textContent).toBe("15");
    await expect(pill.querySelector(".nav-failed")?.textContent?.trim()).toBe(
      "2",
    );
    await expect(pill.querySelector(".nav-passed")?.textContent?.trim()).toBe(
      "10",
    );
    await expect(pill.querySelector(".nav-running")?.textContent?.trim()).toBe(
      "3",
    );
    // Each count carries its glyph, so colour is never alone.
    for (const kind of ["failed", "passed", "running"]) {
      await expect(pill.querySelector(`.nav-${kind} svg`)).not.toBeNull();
    }
  }}
>
  {@render inLink({ total: 15, failed: 2, passed: 10, running: 3 })}
</Story>

<!-- Nothing failing: a zero is never drawn. -->
<Story
  asChild
  name="Passing only"
  play={async ({ canvasElement }) => {
    const pill = canvasElement.querySelector(".nav-pills") as HTMLElement;
    await expect(pill.querySelector(".nav-passed")?.textContent?.trim()).toBe(
      "6",
    );
    for (const kind of ["none", "failed", "running"]) {
      await expect(pill.querySelector(`.nav-${kind}`)).toBeNull();
    }
  }}
>
  {@render inLink({ total: 6, failed: 0, passed: 6, running: 0 })}
</Story>

<!-- Branches also counts the ones with no pipeline. -->
<Story
  asChild
  name="Branches with no pipeline"
  play={async ({ canvasElement }) => {
    // Outcomes, the divider, the state, then the branches with no pipeline,
    // which are neither (#1563).
    await expect(order(canvasElement)).toEqual([
      "nav-total",
      "nav-failed",
      "nav-passed",
      "nav-divider",
      "nav-running",
      "nav-none",
    ]);
    await expect(canvasElement.querySelector(".nav-none svg")).not.toBeNull();
  }}
>
  {@render inLink({ total: 9, failed: 1, passed: 6, running: 1, none: 1 })}
</Story>

<!-- A branch held for workflow approval is drawn, so the parts add up to the
     total (#2024). -->
<Story
  asChild
  name="Waiting for approval"
  play={async ({ canvasElement }) => {
    const pill = canvasElement.querySelector(".nav-pills") as HTMLElement;
    await expect(pill.querySelector(".nav-total")?.textContent).toBe("8");
    await expect(pill.querySelector(".nav-awaiting")?.textContent?.trim()).toBe(
      "1",
    );
    await expect(pill.querySelector(".nav-awaiting svg")).not.toBeNull();
    const shown = [...pill.querySelectorAll(".nav-count")].reduce(
      (n, el) => n + Number(el.textContent?.trim()),
      0,
    );
    await expect(shown).toBe(8);
  }}
>
  {@render inLink({
    total: 8,
    failed: 0,
    running: 4,
    passed: 3,
    none: 0,
    awaitingApproval: 1,
  })}
</Story>

<!-- Nothing in the page: no pill at all. -->
<Story
  asChild
  name="Empty"
  play={async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".nav-pills")).toBeNull();
  }}
>
  {@render inLink({ total: 0, failed: 0 })}
</Story>

<!-- The first refresh has not finished: a dash, never a 0. -->
<Story
  asChild
  name="First refresh pending"
  play={async ({ canvasElement }) => {
    const pill = canvasElement.querySelector(".nav-pills") as HTMLElement;
    await expect(pill.textContent?.trim()).toBe("–");
    // The dash is hidden from assistive tech: the link keeps its plain name.
    await expect(pill.getAttribute("aria-hidden")).toBe("true");
    await expect(
      within(canvasElement).getByRole("link", { name: /^Pull requests$/ }),
    ).not.toBeNull();
  }}
>
  {@render inLink(null, { pending: true })}
</Story>

<!-- The phone layout stacks the counts under the total. -->
<Story asChild name="Stacked">
  {@render inLink(
    { total: 15, failed: 2, passed: 10, running: 3 },
    { stacked: true },
  )}
</Story>
