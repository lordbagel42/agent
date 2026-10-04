<script lang="ts">
  import { timestamp } from "$lib/projection.js";
  let {
    value,
    utc = false,
    compact = false,
  }: { value: unknown; utc?: boolean; compact?: boolean } = $props();
  const at = $derived(timestamp(value));
  const formatted = $derived(
    at === null
      ? "Time unknown"
      : new Intl.DateTimeFormat(undefined, {
          year: compact ? undefined : "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: compact ? undefined : "2-digit",
          timeZone: utc ? "UTC" : undefined,
          timeZoneName: compact ? undefined : "short",
        }).format(at),
  );
</script>

{#if at === null}
  <span class="muted">Time unknown</span>
{:else}
  <time datetime={new Date(at).toISOString()} title={new Date(at).toISOString()}
    >{formatted}</time
  >
{/if}
