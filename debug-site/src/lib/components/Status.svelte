<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  let { value }: { value: string } = $props();
  const tone = $derived(
    ["sent", "delivered", "read"].includes(value)
      ? "ok"
      : ["rejected", "failed"].includes(value)
        ? "danger"
        : ["unknown", "uncertain", "Pending", "Deferred", "sending"].includes(
              value,
            )
          ? "warn"
          : "neutral",
  );
</script>

<Badge variant="outline" class={`state-badge state-${tone}`}
  ><span class="state-dot" aria-hidden="true"></span>{value}</Badge
>
