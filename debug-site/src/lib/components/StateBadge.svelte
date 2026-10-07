<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { statusLabel, tone } from "$lib/display.js";
  import type { OperationEvent } from "$lib/types.js";
  let { event }: { event: Pick<OperationEvent, "failure" | "status"> } =
    $props();
</script>

<Badge variant="outline" class={`state-badge state-${tone(event)}`}
  ><span class="state-dot" aria-hidden="true"></span>{statusLabel(
    event.status,
  )}</Badge
>
