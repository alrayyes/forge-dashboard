<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import axe from "axe-core";
  import { expect, waitFor } from "storybook/test";
  import { mockFetch } from "../../.storybook/mock-fetch";
  import Footer from "./Footer.svelte";

  // Footer reads the page's path from $app/state, the one thing Storybook
  // mocks here, and the version from /api/version.
  const { Story } = defineMeta({
    title: "Footer",
    component: Footer,
  });

  const page = (pathname: string) => ({
    sveltekit_experimental: {
      state: {
        page: { url: new URL(pathname, "https://dashboard.example.test") },
      },
    },
  });

  const links = (el: HTMLElement) => [...el.querySelectorAll("footer a")];
  const names = (el: HTMLElement) => links(el).map((a) => a.textContent);
  const current = (el: HTMLElement) =>
    links(el).filter((a) => a.hasAttribute("aria-current"));
  // The footer's text as a reader gets it, non-breaking spaces as spaces.
  const text = (el: HTMLElement) =>
    (el.querySelector("footer") as HTMLElement).innerText
      .replace(/\u00a0/g, " ")
      .trim();

  // The links are drawn once the version request answers (or fails).
  const released = async (el: HTMLElement) =>
    waitFor(() =>
      expect(names(el)).toEqual(["GitHub", "v9.2.9", "Disclaimer", "Privacy"]),
    );

  // Runs axe over the story in the given theme and fails on any violation.
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
</script>

<!-- A released build: the version links to the changelog. -->
<Story
  name="Released version"
  parameters={page("/")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "9.2.9" } }])}
  play={async ({ canvasElement }) => {
    await released(canvasElement);
    // Same items, same order, on every page (#1679); none current here.
    await expect(current(canvasElement)).toEqual([]);
    const [github, version, disclaimer, privacy] = links(canvasElement);
    await expect(github.getAttribute("href")).toBe(
      "https://github.com/alrayyes/forge-dashboard",
    );
    await expect(github.getAttribute("target")).toBe("_blank");
    await expect(github.getAttribute("rel")).toBe("noopener noreferrer");
    // The mark is decoration: the word names the link.
    await expect(github.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    await expect(version.getAttribute("href")).toBe("/changelog.html");
    await expect(disclaimer.getAttribute("href")).toBe("/disclaimer.html");
    await expect(privacy.getAttribute("href")).toBe("/privacy.html");
    await expect(canvasElement.textContent).not.toContain("Read-only mirror");
  }}
/>

<!-- A dev build: a plain label, no link. -->
<Story
  name="Dev build"
  parameters={page("/")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "dev" } }])}
  play={async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelector("#footer-version")?.textContent,
      ).toContain("dev build"),
    );
    await expect(names(canvasElement)).toEqual([
      "GitHub",
      "Disclaimer",
      "Privacy",
    ]);
    await expect(text(canvasElement)).toMatch(
      /^GitHub\s+· dev build\s+· Disclaimer\s+· Privacy$/,
    );
    await expect(current(canvasElement)).toEqual([]);
  }}
/>

<!-- A dev build on the disclaimer page: the label stays and the page's own
     link is the one marked current. -->
<Story
  name="Dev build on the disclaimer page"
  parameters={page("/disclaimer.html")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "dev" } }])}
  play={async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelector("#footer-version")?.textContent,
      ).toContain("dev build"),
    );
    await expect(names(canvasElement)).toEqual([
      "GitHub",
      "Disclaimer",
      "Privacy",
    ]);
    await expect(text(canvasElement)).toMatch(
      /^GitHub\s+· dev build\s+· Disclaimer\s+· Privacy$/,
    );
    await expect(current(canvasElement).map((a) => a.textContent)).toEqual([
      "Disclaimer",
    ]);
  }}
/>

<!-- The version has not answered: nothing is shown for it. -->
<Story
  name="Version unresolved"
  parameters={page("/")}
  beforeEach={() => mockFetch([{ match: /\/api\/version/, hang: true }])}
/>

<!-- The version request failed: still nothing, no error. -->
<Story
  name="Version request fails"
  parameters={page("/")}
  beforeEach={() => mockFetch([{ match: /\/api\/version/, status: 500 }])}
/>

<!-- On the privacy page its link keeps its place and is marked current. -->
<Story
  name="Privacy page current"
  parameters={page("/privacy")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "9.2.9" } }])}
  play={async ({ canvasElement }) => {
    await released(canvasElement);
    const marked = current(canvasElement);
    await expect(marked.map((a) => a.textContent)).toEqual(["Privacy"]);
    await expect(marked[0].getAttribute("aria-current")).toBe("page");
    // Not colour alone: the current link is underlined 2px, the others 1px.
    const style = getComputedStyle(marked[0]);
    await expect(style.textDecorationLine).toContain("underline");
    await expect(style.textDecorationThickness).toBe("2px");
  }}
/>

<!-- The version link is the current one on the changelog page. -->
<Story
  name="Changelog page current"
  parameters={page("/changelog.html")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "9.2.9" } }])}
  play={async ({ canvasElement }) => {
    await released(canvasElement);
    await expect(current(canvasElement).map((a) => a.textContent)).toEqual([
      "v9.2.9",
    ]);
    await expect(current(canvasElement)[0].getAttribute("aria-current")).toBe(
      "page",
    );
  }}
/>

<!-- No accessibility violations in either theme, on a page whose link is
     current. -->
<Story
  name="Accessible in both themes"
  parameters={page("/disclaimer.html")}
  beforeEach={() =>
    mockFetch([{ match: /\/api\/version/, body: { version: "9.2.9" } }])}
  play={async ({ canvasElement }) => {
    await released(canvasElement);
    await expectNoViolations(canvasElement, "light");
    await expectNoViolations(canvasElement, "dark");
  }}
/>
