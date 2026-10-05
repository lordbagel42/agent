<script lang="ts">
  import "../app.css";
  import "@fontsource-variable/geist";
  import "@fontsource-variable/geist-mono";
  import { onMount } from "svelte";
  import type { LayoutProps } from "./$types";
  let { children }: LayoutProps = $props();
  onMount(() => {
    try {
      document.documentElement.classList.toggle(
        "dark",
        localStorage.getItem("sandbox-theme") !== "light",
      );
    } catch {
      /* Default to dark. */
    }
  });
</script>

<svelte:head>
  <link rel="icon" href="/favicon.svg" />
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="#0a0a0a" />
</svelte:head>

{@render children()}
