<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect } from "storybook/test";
  import "./forge-labels-fixture";
  import ForgeHealth from "./ForgeHealth.svelte";

  const { Story } = defineMeta({
    title: "ForgeHealth",
    component: ForgeHealth,
    args: { ago: (iso: string) => `ago(${iso})` },
  });

  const inMinutes = (m: number) =>
    new Date(Date.now() + m * 60_000).toISOString();
  const limit = (max: number, remaining: number, minutes = 40) => ({
    limit: max,
    remaining,
    resetsAt: inMinutes(minutes),
  });
  const budgets = (root: HTMLElement) =>
    Array.from(root.querySelectorAll(".forge-health-budget"));
</script>

<!-- A forge with current rows and budget left has nothing to act on (#3681). -->
<Story
  name="Healthy"
  args={{
    forges: [
      {
        forge: "github",
        reachable: true,
        rateLimitREST: limit(5000, 4900),
      },
    ],
  }}
  play={async ({ canvasElement }) => {
    await expect(canvasElement.textContent?.trim()).toBe("");
    await expect(canvasElement.querySelector(".forge-health")).toBeNull();
    await expect(budgets(canvasElement)).toHaveLength(0);
  }}
/>

<!-- Each budget is labelled, and only the one that is low shows (#1433). -->
<Story
  name="Spent GraphQL budget beside a healthy REST one"
  args={{
    forges: [
      {
        forge: "github",
        reachable: true,
        rateLimitGraphQL: limit(5000, 0, 12),
        rateLimitREST: limit(5000, 4800),
      },
    ],
  }}
  play={async ({ canvasElement }) => {
    const lines = budgets(canvasElement);
    await expect(lines).toHaveLength(1);
    await expect(lines[0].textContent).toMatch(
      /^GH GraphQL: 0\/5,000 reqs, resets .+/,
    );
    await expect(canvasElement.textContent).not.toContain("GH REST");
    // The numbers change on every poll, so the live region has its own copy.
    await expect(lines[0].getAttribute("aria-live")).toBe("off");
  }}
/>

<Story
  name="One budget names itself"
  args={{
    forges: [
      { forge: "github", reachable: true, rateLimitREST: limit(5000, 800) },
    ],
  }}
  play={async ({ canvasElement }) => {
    const lines = budgets(canvasElement);
    await expect(lines).toHaveLength(1);
    await expect(lines[0].textContent).toMatch(/^GH REST: 800\/5,000 reqs/);
    await expect(canvasElement.textContent).not.toMatch(/GH: /);
  }}
/>

<Story
  name="Forgejo budget uses its own short name"
  args={{
    forges: [
      { forge: "forgejo", reachable: true, rateLimitREST: limit(1000, 150) },
    ],
  }}
  play={async ({ canvasElement }) => {
    const lines = budgets(canvasElement);
    await expect(lines).toHaveLength(1);
    await expect(lines[0].textContent).toMatch(/^FJ REST: 150\/1,000 reqs/);
  }}
/>

<!-- A count above its limit is a bad reading, not a budget. -->
<Story
  name="Remaining above its limit"
  args={{
    forges: [
      {
        forge: "github",
        reachable: true,
        rateLimitREST: {
          limit: 1000,
          remaining: 9992,
          resetsAt: inMinutes(40),
        },
      },
    ],
  }}
  play={async ({ canvasElement }) => {
    await expect(budgets(canvasElement)).toHaveLength(0);
  }}
/>

<Story
  name="Starting up"
  args={{ forges: [{ forge: "github", reachable: true, starting: true }] }}
  play={async ({ canvasElement }) => {
    const chip = canvasElement.querySelector(".forge-health.starting");
    await expect(chip?.textContent).toBe("GitHub loading");
    await expect(chip?.querySelector(".pulse-dot")).not.toBeNull();
  }}
/>

<!-- The banner says an outage once: no chip, no age line, no cause (#3719). -->
<Story
  name="Unreachable draws nothing"
  args={{
    forges: [
      {
        forge: "github",
        reachable: false,
        errorKind: "unreachable",
        error: "dial tcp: i/o timeout",
        staleSince: "2026-01-01T00:00:00Z",
      },
    ],
  }}
  play={async ({ canvasElement }) => {
    await expect(canvasElement.textContent?.trim()).toBe("");
    await expect(canvasElement.querySelector("details")).toBeNull();
  }}
/>

<!-- Rate limited and unreachable: no outage banner, so all three lines stay. -->
<Story
  name="Unreachable and rate limited"
  args={{
    forges: [
      {
        forge: "github",
        reachable: false,
        errorKind: "unreachable",
        error: "dial tcp: i/o timeout",
        staleSince: "2026-01-01T00:00:00Z",
        rateLimitREST: limit(5000, 0),
      },
    ],
  }}
  play={async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".forge-health.unreachable")?.textContent,
    ).toBe("GitHub unreachable");
    await expect(
      canvasElement.querySelector(".forge-health-stale")?.textContent,
    ).toBe("Showing data from ago(2026-01-01T00:00:00Z)");
    await expect(
      canvasElement.querySelector(".forge-health-error")?.textContent,
    ).toContain("try the refresh button");
    const details = canvasElement.querySelector("details");
    await expect(details?.querySelector("summary")?.textContent).toBe(
      "Show details",
    );
    await expect(details?.textContent).toContain("dial tcp: i/o timeout");
    await expect(budgets(canvasElement)).toHaveLength(1);
  }}
/>

<Story
  name="Rate limited with a rate_limited error says it only in the banner"
  args={{
    forges: [
      {
        forge: "github",
        reachable: false,
        errorKind: "rate_limited",
        error: "403",
        rateLimitREST: limit(5000, 0),
      },
    ],
  }}
  play={async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".forge-health-error")).toBeNull();
    await expect(canvasElement.querySelector("details")).toBeNull();
  }}
/>
