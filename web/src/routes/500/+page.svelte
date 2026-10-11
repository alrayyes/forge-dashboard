<script lang="ts">
  import ErrorPage from "#lib/ErrorPage.svelte";
</script>

<!-- Prerendered to /500.html: the finished page the Go server serves, with the
     real status, for a failure the router never sees (#1175). -->
<ErrorPage status={500} />
