<script lang="ts">
  import { page } from "$app/state";
  import ErrorPage from "#lib/ErrorPage.svelte";
</script>

<ErrorPage status={page.status} />
