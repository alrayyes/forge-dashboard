<script module lang="ts">
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import RepoLogo from "./RepoLogo.svelte";

  const { Story } = defineMeta({
    title: "RepoLogo",
    component: RepoLogo,
    // The component sits beside the repository's name in a row.
    decorators: [],
  });
</script>

<!-- avatarSrc only loads https, through the image proxy. The screenshot script
     answers a proxy request for logos.example.test with a small SVG, so this
     story needs no network. -->
<Story
  name="With a logo"
  args={{ url: "https://logos.example.test/forge-dashboard.svg" }}
/>

<!-- A forge with no logo: nothing is drawn, so a row does not shift. -->
<Story name="No logo" args={{ url: undefined }} />

<!-- The image fails to load: it is dropped and the name stays alone. -->
<Story
  name="Logo fails to load"
  args={{ url: "https://logos.example.test/missing.png" }}
/>

<!-- An http URL is refused, since the dashboard is served over https. -->
<Story name="Insecure URL" args={{ url: "http://logos.example.test/a.png" }} />
