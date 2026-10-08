<script lang="ts">
  import {
    ArrowUpRight,
    CircleCheck,
    CircleDot,
    RefreshCw,
  } from "@lucide/svelte";
  import type { ArchiveState } from "$lib/archive.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { link } from "$lib/display.js";
  import type { Route } from "$lib/route.js";
  import Loading from "./Loading.svelte";
  import Time from "./Time.svelte";

  let {
    state: archive,
    utc,
    compact = false,
    onrefresh,
    onnavigate,
  }: {
    state: ArchiveState;
    utc: boolean;
    compact?: boolean;
    onrefresh: () => void;
    onnavigate: (route: Route) => void;
  } = $props();
  let filter = $state("all");
  let query = $state("");
  const items = $derived(
    (archive.issues?.items ?? []).filter(
      (issue) =>
        (compact || filter === "all" || issue.state === filter) &&
        (compact ||
          `${issue.number} ${issue.title}`
            .toLowerCase()
            .includes(query.toLowerCase())),
    ),
  );
  const phases = {
    pending: "Awaiting Amp",
    claimed: "Claimed · awaiting launch",
    running: "Running",
    returned: "Amp returned",
    unknown: "Needs reconciliation",
    skipped: "Closed before triage",
    reconciled: "Operator reconciled",
    unavailable: "Investigation unavailable",
    queued: "Investigation queued",
  };
</script>

<section
  class="issues-view"
  class:compact
  aria-label={compact ? "Capture issue" : "GitHub issues"}
>
  <div class="issues-heading">
    <div>
      {#if compact}<h2>Tracking issue</h2>{:else}<h1>Issues</h1>
        <p class="muted">
          GitHub tracks the work. Private evidence stays here.
        </p>{/if}
    </div>
    <div class="inline-actions">
      <Button
        variant="outline"
        onclick={onrefresh}
        disabled={archive.issuesBusy}
        ><RefreshCw size={14} aria-hidden="true" />Refresh</Button
      >
      {#if !compact}<Button
          href="https://github.com/lordbagel42/agent/issues/new"
          target="_blank"
          rel="noreferrer"
          >New issue<ArrowUpRight size={14} aria-hidden="true" /></Button
        >{/if}
    </div>
  </div>
  {#if archive.issuesBusy}<Loading label="Loading issue metadata…" />
  {:else if archive.issuesError}
    <p class="action-error" role="alert">
      Issue metadata could not be loaded. Refresh to try again; no work was
      started.
    </p>
  {:else if archive.issues && !archive.issues.enabled}
    <div class="issue-notice">
      <h2>Issue tracking is not enabled</h2>
      <p>
        The independent tracker and Amp worker need operator configuration.
        Captured evidence is still available.
      </p>
    </div>
  {:else if archive.issues}
    {#if archive.issues.error}<p class="action-error" role="alert">
        GitHub sync is unavailable. These are the last saved observations, not
        current status.
      </p>{/if}
    {#if !compact}
      <div class="issues-controls">
        <Input
          aria-label="Search issues"
          placeholder="Search title or issue number…"
          bind:value={query}
        />
        <select aria-label="Issue state" bind:value={filter}
          ><option value="all">All states</option><option value="open"
            >Open</option
          ><option value="closed">Closed</option></select
        >
        <span class="muted">{items.length} of {archive.issues.total}</span>
      </div>
    {/if}
    {#if items.length}
      <ul class="issue-list">
        {#each items as issue (issue.number)}
          <li class="issue-row">
            <div class="issue-summary">
              <a
                class="issue-title"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                ><span class="issue-number mono muted">#{issue.number}</span
                >{issue.title}<ArrowUpRight size={14} aria-hidden="true" /></a
              >
              <div class="issue-links">
                {#each issue.sources as source}
                  {#if source.startsWith("debug:")}
                    <a
                      {...link(
                        {
                          view: "capture",
                          id: source.slice(6),
                          page: "evidence",
                        },
                        onnavigate,
                      )}
                      >Capture <span class="mono">{source.slice(6, 14)}</span
                      ></a
                    >
                  {:else}<span>Recovery incident {source.slice(9)}</span>{/if}
                {/each}
                {#if issue.threadId}<a
                    href={`https://ampcode.com/threads/${issue.threadId}`}
                    target="_blank"
                    rel="noreferrer">Amp thread ↗</a
                  >{/if}
                {#if issue.commit}<a
                    href={`https://github.com/lordbagel42/agent/commit/${issue.commit}`}
                    target="_blank"
                    rel="noreferrer"
                    >Published <span class="mono"
                      >{issue.commit.slice(0, 7)}</span
                    > ↗</a
                  >{/if}
                {#if !issue.sources.length && issue.job}<span
                    >{issue.job.ownerRequest
                      ? "Owner request"
                      : "Other author"}</span
                  >{/if}
              </div>
            </div>
            <div class="issue-state">
              <Badge variant="outline">
                {#if issue.state === "open"}<CircleDot
                    size={12}
                    aria-hidden="true"
                  />Open
                {:else}<CircleCheck size={12} aria-hidden="true" />Closed{/if}
              </Badge>
              <span
                class:issue-uncertain={issue.job?.phase === "unknown" ||
                  issue.phase === "unknown"}
                >{issue.job
                  ? phases[issue.job.phase]
                  : issue.captureOnly
                    ? "Capture only"
                    : issue.phase
                      ? phases[issue.phase]
                      : issue.sources.length
                        ? "Dispatch unobserved"
                        : "Not queued"}</span
              >
            </div>
            {#if !compact}<div class="issue-updated">
                <span class="muted">Updated</span><Time
                  value={issue.updatedAt}
                  {utc}
                />
              </div>{/if}
          </li>
        {/each}
      </ul>
    {:else if !archive.issues.pending.length}
      <div class="issue-notice">
        <h2>{compact ? "No linked issue" : "No matching issues"}</h2>
        <p>
          {compact
            ? "This capture may predate issue tracking. Historical captures are not backfilled."
            : "New issues appear after GitHub sync. Only issues created after activation receive an automatic assignment."}
        </p>
      </div>
    {/if}
    {#if archive.issues.pending.length}
      <div class="issue-notice">
        <h2>Awaiting GitHub linkage</h2>
        {#each archive.issues.pending as pending}<p>
            <code>{pending.source}</code> · {pending.status === "unknown"
              ? "Creation outcome unknown — reconcile before retrying"
              : "Queued for the next sync"}
          </p>{/each}
      </div>
    {/if}
    <p class="issues-footnote">
      {#if archive.issues.checkedAt}Last sync <Time
          value={new Date(archive.issues.checkedAt).toISOString()}
          {utc}
        />.{:else}No successful GitHub sync recorded.{/if}
      Amp returned ≠ code shipped. Published code ≠ deployed.
      {#if !compact}DEBUG stays capture-only; DEBUGSHARE and recovery keep their
        existing investigator.{/if}
    </p>
  {/if}
</section>
