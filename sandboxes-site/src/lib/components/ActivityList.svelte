<script lang="ts">
  import { Check, Circle, CircleAlert, Square } from "@lucide/svelte";
  import { activityLabel, timestamp, type Activity } from "$lib/snapshot";
  let { entries, since }: { entries: Activity[]; since: string } = $props();
</script>

<p class="section-note">
  Metadata only · up to 200 events since {timestamp(since)}. Resets when June
  restarts.
</p>
{#if entries.length}
  <ol class="activity-list">
    {#each entries as entry (entry.sequence)}
      <li>
        <span
          class:warning={entry.kind === "command_failed" ||
            entry.kind === "cleanup_unknown"}
          class="event-icon"
        >
          {#if entry.kind === "command_failed" || entry.kind === "cleanup_unknown"}<CircleAlert
              size={16}
            />
          {:else if entry.kind === "command_completed"}<Check size={16} />
          {:else if entry.kind === "stopped" || entry.kind === "destroyed"}<Square
              size={13}
            />
          {:else}<Circle size={13} />{/if}
        </span>
        <div class="event-body">
          <strong>{activityLabel[entry.kind]}</strong><span class="mono muted"
            >worker {entry.worker.slice(0, 12)}{entry.exitCode !== undefined
              ? ` · exit ${entry.exitCode}`
              : ""}</span
          >
        </div>
        <time datetime={entry.at}>{timestamp(entry.at)}</time>
      </li>
    {/each}
  </ol>
{:else}
  <div class="quiet-empty">
    <Circle size={24} strokeWidth={1.25} />
    <h3>No recorded activity</h3>
    <p>
      Events appear when June uses a sandbox. Previous process history is not
      retained here.
    </p>
  </div>
{/if}
