<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import axe from "axe-core";
  import { expect, fn, userEvent, within } from "storybook/test";
  import LiveControl from "./LiveControl.svelte";

  const { Story } = defineMeta({
    title: "LiveControl",
    component: LiveControl,
  });

  const ago = (seconds: number) =>
    new Date(Date.now() - seconds * 1000).toISOString();

  const control = (el: HTMLElement) =>
    el.querySelector(".live-control") as HTMLElement;

  // Runs axe over the story in the given theme and fails on any violation,
  // with the rule ids in the message. The theme is put back afterwards.
  async function expectNoViolations(el: HTMLElement, theme: "light" | "dark") {
    const root = document.documentElement;
    const before = root.getAttribute("data-theme");
    root.setAttribute("data-theme", theme);
    try {
      const { violations } = await axe.run(el);
      await expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    } finally {
      if (before === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", before);
    }
  }

  const onpause = fn();
  const onrefresh = fn();
</script>

<script lang="ts">
  let paused = $state(false);
</script>

<!-- Live: the status word, the age of the snapshot, Pause, and refresh, in
     that order, as one named group (#3699). -->
<Story
  name="Live"
  args={{ paused: false, updatedAt: ago(12), onpause, onrefresh }}
  beforeEach={() => {
    onpause.mockClear();
    onrefresh.mockClear();
  }}
  play={async ({ canvasElement }) => {
    const live = control(canvasElement);
    await expect(live.getAttribute("role")).toBe("group");
    await expect(live.getAttribute("aria-label")).toBe("Live updates");
    await expect(live.classList.contains("paused")).toBe(false);
    await expect(live.querySelector(".live-status")?.textContent).toBe("Live");
    // The dot is decoration: the word carries the state.
    await expect(
      live.querySelector(".live-dot")?.getAttribute("aria-hidden"),
    ).toBe("true");
    await expect(live.querySelector(".live-updated")?.textContent).toMatch(
      /^updated \d+s ago$/,
    );
    // Status, time, Pause, refresh: in that order.
    await expect(
      [...live.children].map((c) => c.getAttribute("class")?.split(" ")[0]),
    ).toEqual(["live-status", "live-updated", "live-pause", "live-refresh"]);

    const pause = within(live).getByRole("button", {
      name: "Pause live updates",
    });
    await expect(pause.textContent).toBe("Pause");
    await expect(pause.id).toBe("pause-updates-button");
    await expect(pause.getAttribute("type")).toBe("button");
    const refresh = within(live).getByRole("button", { name: "Refresh now" });
    await expect(refresh.id).toBe("force-refresh-button");
    await expect(refresh.getAttribute("type")).toBe("button");
    await expect(refresh.getAttribute("title")).toBe("Refresh now");
    await expect(
      refresh.querySelector("svg")?.getAttribute("aria-hidden"),
    ).toBe("true");
    await expect(refresh.getAttribute("aria-disabled")).toBeNull();

    await userEvent.click(pause);
    await expect(onpause).toHaveBeenCalledTimes(1);
    await userEvent.click(refresh);
    await expect(onrefresh).toHaveBeenCalledTimes(1);
  }}
/>

<!-- Paused: the word and the button change, the time stays. The accessible
     name of Resume holds its visible word (WCAG 2.5.3). -->
<Story
  name="Paused"
  args={{ paused: true, updatedAt: ago(7200), onpause, onrefresh }}
  play={async ({ canvasElement }) => {
    const live = control(canvasElement);
    await expect(live.classList.contains("paused")).toBe(true);
    await expect(live.querySelector(".live-status")?.textContent).toBe(
      "Paused",
    );
    await expect(live.querySelector(".live-updated")?.textContent).toBe(
      "updated 2h ago",
    );
    const resume = within(live).getByRole("button", {
      name: "Resume live updates",
    });
    await expect(resume.textContent).toBe("Resume");
    await expect(
      within(live).queryByRole("button", { name: /Pause/ }),
    ).toBeNull();
    await expect(live.textContent).not.toContain("Live");
  }}
/>

<!-- No snapshot yet: the time is left out rather than drawn as 0s. -->
<Story
  name="No time yet"
  args={{ paused: false, updatedAt: null, onpause, onrefresh }}
  play={async ({ canvasElement }) => {
    const live = control(canvasElement);
    await expect(live.querySelector(".live-updated")).toBeNull();
    await expect(live.querySelector(".live-status")?.textContent).toBe("Live");
  }}
/>

<!-- A refresh the user asked for is running: aria-disabled keeps keyboard
     focus on the button, and a press is ignored. -->
<Story
  name="Refreshing"
  args={{
    paused: false,
    updatedAt: ago(30),
    onpause,
    onrefresh,
    refreshing: true,
  }}
  beforeEach={() => onrefresh.mockClear()}
  play={async ({ canvasElement }) => {
    const refresh = within(control(canvasElement)).getByRole("button", {
      name: "Refresh now",
    });
    await expect(refresh.getAttribute("aria-disabled")).toBe("true");
    await expect(refresh.hasAttribute("disabled")).toBe(false);
    await expect(refresh.classList.contains("is-refreshing")).toBe(true);
    refresh.focus();
    await expect(document.activeElement).toBe(refresh);
    await userEvent.click(refresh);
    await userEvent.keyboard("{Enter}");
    await expect(onrefresh).not.toHaveBeenCalled();
    await expect(document.activeElement).toBe(refresh);
  }}
/>

<!-- The page owns what Pause does and passes it back as `paused`: the word
     and the button follow, both ways. -->
<Story
  asChild
  name="Pause and Resume"
  beforeEach={() => {
    paused = false;
  }}
  play={async ({ canvasElement }) => {
    const live = control(canvasElement);
    await userEvent.click(
      within(live).getByRole("button", { name: "Pause live updates" }),
    );
    await expect(live.querySelector(".live-status")?.textContent).toBe(
      "Paused",
    );
    await userEvent.click(
      within(live).getByRole("button", { name: "Resume live updates" }),
    );
    await expect(live.querySelector(".live-status")?.textContent).toBe("Live");
    await expect(live.classList.contains("paused")).toBe(false);
  }}
>
  <LiveControl
    {paused}
    updatedAt={ago(5)}
    onpause={() => (paused = !paused)}
    {onrefresh}
  />
</Story>

<!-- No accessibility violations in either theme, live and paused. -->
<Story
  name="Live, light and dark"
  args={{ paused: false, updatedAt: ago(12), onpause, onrefresh }}
  play={async ({ canvasElement }) => {
    await expectNoViolations(canvasElement, "light");
    await expectNoViolations(canvasElement, "dark");
  }}
/>

<Story
  name="Paused, light and dark"
  args={{ paused: true, updatedAt: ago(7200), onpause, onrefresh }}
  play={async ({ canvasElement }) => {
    await expectNoViolations(canvasElement, "light");
    await expectNoViolations(canvasElement, "dark");
  }}
/>
