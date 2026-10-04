<script lang="ts">
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  let {
    label = "Loading captured evidence…",
    compact = false,
  }: { label?: string; compact?: boolean } = $props();
</script>

<div class:compact class="loading-state" role="status" aria-label={label}>
  <span class="sr-only">{label}</span>
  <div aria-hidden="true" class="loading-lines">
    <Skeleton class="skeleton-heading" />
    <Skeleton class="skeleton-summary" />
    {#each [1, 2, 3, 4, 5] as line (line)}<Skeleton
        class="skeleton-row"
      />{/each}
  </div>
</div>
