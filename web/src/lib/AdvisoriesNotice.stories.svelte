<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, within } from "storybook/test";
  import AdvisoriesNotice from "./AdvisoriesNotice.svelte";

  const { Story } = defineMeta({
    title: "AdvisoriesNotice",
    component: AdvisoriesNotice,
    args: { forge: "github", reason: null },
  });

  const DOCS =
    "https://github.com/alrayyes/forge-dashboard/blob/main/docs/main-branches.md";
  const GRANT_DOC = `${DOCS}#when-advisories-cant-be-read`;
  const FORGEJO_DOC = `${DOCS}#forgejo-advisories`;
</script>

<!-- Every GitHub row is unknown and the server gave no cause, or the rows
     disagree: the notice lists the likely ones and the way to grant access. -->
<Story
  name="GitHub, cause unknown"
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveAttribute("data-testid", "advisories-notice");
    // The banner's own styling comes from the shared stylesheet.
    await expect(getComputedStyle(notice).display).toBe("flex");
    await expect(getComputedStyle(notice).borderLeftWidth).toBe("4px");
    await expect(notice).toHaveTextContent("Dependabot alerts permission");
    await expect(notice).toHaveTextContent(/rate\s+limit/i);
    await expect(notice).toHaveTextContent(
      /up\s+to\s+an\s+hour\s+and\s+a\s+quarter/i,
    );
    await expect(notice).toHaveTextContent(/saving\s+Settings/i);
    const link = within(notice).getByRole("link", { name: /How to grant it/ });
    await expect(link).toHaveAttribute("href", GRANT_DOC);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAccessibleName(
      "How to grant it (opens in a new tab)",
    );
  }}
/>

<!-- GitHub refused the read: the credential needs the permission, so the way
     to grant it stays. -->
<Story
  name="GitHub, refused"
  args={{ reason: "refused" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveTextContent("refused the read");
    await expect(
      within(notice).getByRole("link", { name: /How to grant it/ }),
    ).toHaveAttribute("href", GRANT_DOC);
  }}
/>

<!-- Alerts are off on the repository: still something to grant. -->
<Story
  name="GitHub, switched off"
  args={{ reason: "switched_off" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveTextContent("switched off");
    await expect(
      within(notice).getByRole("link", { name: /How to grant it/ }),
    ).toBeInTheDocument();
  }}
/>

<!-- A rate limit clears by itself, so the notice sends nobody to permissions. -->
<Story
  name="GitHub, rate limited"
  args={{ reason: "throttled" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveTextContent(/rate\s+limiting/i);
    await expect(notice).not.toHaveTextContent("Dependabot alerts permission");
    await expect(within(notice).queryByRole("link")).toBeNull();
  }}
/>

<!-- A GitHub error is the same: wait, change nothing. -->
<Story
  name="GitHub, read failed"
  args={{ reason: "failed" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveTextContent("returned an error");
    await expect(within(notice).queryByRole("link")).toBeNull();
  }}
/>

<!-- Too many alerts to read in one go. -->
<Story
  name="GitHub, too many"
  args={{ reason: "too_many" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveTextContent(/Advisories can't be read/);
    await expect(within(notice).queryByRole("link")).toBeNull();
  }}
/>

<!-- Forgejo rows with no cause: the generic reasons, and its own page. -->
<Story
  name="Forgejo, cause unknown"
  args={{ forge: "forgejo" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveAttribute(
      "data-testid",
      "forgejo-advisories-notice",
    );
    await expect(notice).toHaveTextContent("Forgejo repositories");
    await expect(notice).toHaveTextContent("OSV may be unreachable");
    await expect(notice).not.toHaveTextContent("permission");
    await expect(notice).not.toHaveTextContent("GitHub");
    const link = within(notice).getByRole("link", {
      name: /How Forgejo advisories are read/,
    });
    await expect(link).toHaveAttribute("href", FORGEJO_DOC);
  }}
/>

<!-- OSV could not be reached, or a lock file could not be read. -->
<Story
  name="Forgejo, read failed"
  args={{ forge: "forgejo", reason: "failed" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveTextContent("OSV could not be reached");
    await expect(notice).not.toHaveTextContent("permission");
    await expect(notice).not.toHaveTextContent("GitHub");
    await expect(
      within(notice).getByRole("link", {
        name: /How Forgejo advisories are read/,
      }),
    ).toHaveAttribute("href", FORGEJO_DOC);
  }}
/>

<!-- A lock file or a repository too big to read in one go. -->
<Story
  name="Forgejo, too many"
  args={{ forge: "forgejo", reason: "too_many" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveTextContent(
      "shows no count rather than a short one",
    );
    await expect(notice).not.toHaveTextContent("GitHub");
  }}
/>

<!-- A forge whose advisory source has no wording of its own: the neutral
     sentence, never GitHub's permission advice. -->
<Story
  name="Other forge, neutral"
  args={{ forge: "nowhere" }}
  play={async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole("status");
    await expect(notice).toHaveAttribute(
      "data-testid",
      "other-advisories-notice",
    );
    await expect(notice).toHaveTextContent("The forge did not answer the read");
    await expect(notice).not.toHaveTextContent("GitHub");
    await expect(notice).not.toHaveTextContent("permission");
    await expect(within(notice).queryByRole("link")).toBeNull();
  }}
/>
