<script lang="ts">
  import { commitHref } from "$lib/display.js";
  let { value }: { value: string | null | undefined } = $props();
  const href = $derived(commitHref(value));
</script>

{#if value && href}<a
    class="mono revision"
    {href}
    target="_blank"
    rel="noreferrer"
    title={`${value} · commit in the June repository`}>{value.slice(0, 7)}</a
  >{:else if value}<code>{value}</code>{:else}<span class="muted"
    >Not recorded</span
  >{/if}
