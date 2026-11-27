<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import { expect, waitFor } from "storybook/test";
  import RepoLogo from "./RepoLogo.svelte";

  const { Story } = defineMeta({
    title: "RepoLogo",
    component: RepoLogo,
    // The component sits beside the repository's name in a row.
    decorators: [],
  });
</script>

<!-- avatarSrc only loads https, through the image proxy. The screenshot script
     answers a proxy request for
     https://logos.example.test/forge-dashboard.svg, and only that path, with a
     small SVG, so this story needs no network. Other paths on the host are
     aborted. -->
<Story
  name="With a logo"
  args={{
    forge: "forgejo",
    url: "https://logos.example.test/forge-dashboard.svg",
    name: "alrayyes/forge-dashboard",
  }}
/>

<!-- A forge with no logo: the repository's initial in the same 16px box, so a
     row does not shift. The screenshot is a small box holding "F", not blank:
     the small size is intended. -->
<Story
  name="No logo"
  args={{ forge: "forgejo", url: undefined, name: "alrayyes/forge-dashboard" }}
/>

<!-- The image fails to load: it is dropped, leaving the initial. The
     screenshot script aborts any logo path but the one above, so this story
     really fails. -->
<Story
  name="Logo fails to load"
  args={{
    forge: "forgejo",
    url: "https://logos.example.test/missing.png",
    name: "alrayyes/forge-dashboard",
  }}
  play={async ({ canvasElement }) => {
    // The test runner does not intercept the logo request, so on a busy
    // machine the failure arrives well after waitFor's 1000 ms default.
    await waitFor(
      () => {
        expect(canvasElement.querySelector("img")).toBeNull();
        expect(canvasElement.querySelector(".logo-placeholder")).not.toBeNull();
      },
      { timeout: 15000 },
    );
  }}
/>

<!-- An http URL is refused, since the dashboard is served over https. The
     initial is drawn instead, so the screenshot is a small box holding "F",
     not blank. That is intended. -->
<Story
  name="Insecure URL"
  args={{
    forge: "forgejo",
    url: "http://logos.example.test/a.png",
    name: "alrayyes/forge-dashboard",
  }}
/>
