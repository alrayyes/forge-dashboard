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
  args={{ url: "https://logos.example.test/forge-dashboard.svg" }}
/>

<!-- A forge with no logo: nothing is drawn, so a row does not shift. A blank
     result is intended. -->
<Story name="No logo" args={{ url: undefined }} />

<!-- The image fails to load: it is dropped and nothing is left. A blank
     result is intended, since RepoLogo draws only the image and no name. The
     screenshot script aborts any logo path but the one above, so this story
     really fails. -->
<Story
  name="Logo fails to load"
  args={{ url: "https://logos.example.test/missing.png" }}
  play={async ({ canvasElement }) => {
    // The test runner does not intercept the logo request, so on a busy
    // machine the failure arrives well after waitFor's 1000 ms default.
    await waitFor(() => expect(canvasElement.querySelector("img")).toBeNull(), {
      timeout: 15000,
    });
  }}
/>

<!-- An http URL is refused, since the dashboard is served over https. A
     blank result is intended: nothing is drawn. -->
<Story name="Insecure URL" args={{ url: "http://logos.example.test/a.png" }} />
