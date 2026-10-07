<script lang="ts">
  import {
    ArrowUpRight,
    ChevronLeft,
    ChevronRight,
    ListFilter,
    RefreshCw,
    Search,
  } from "@lucide/svelte";
  import { onMount, tick } from "svelte";
  import type { OperationFilters, OperationsState } from "$lib/archive.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import type { OperationEvent, OperationSummary } from "$lib/types.js";
  import Loading from "./Loading.svelte";
  import Time from "./Time.svelte";

  let {
    state: operations,
    utc,
    onsearch,
    onselect,
    onevents,
    onrefresh,
  }: {
    state: OperationsState;
    utc: boolean;
    onsearch: (filters: Partial<OperationFilters>) => void;
    onselect: (id: string) => void;
    onevents: (offset: number) => void;
    onrefresh: () => void;
  } = $props();
  let query = $state("");
  let source = $state<OperationFilters["source"]>("");
  let listOpen = $state(false);
  let now = $state(Date.now());
  let detailHeading: HTMLElement | undefined = $state();
  let resultsHeading: HTMLElement | undefined = $state();
  const controller = $derived(operations.index?.controller);
  const control = $derived(controller?.controller);
  const stale = $derived(
    controller ? now - controller.observedAt > 300_000 : false,
  );
  const clockSkew = $derived(controller ? controller.observedAt > now : false);
  $effect(() => {
    if (controller) now = Date.now();
  });
  const detail = $derived(operations.detail);
  const sources: { value: OperationEvent["source"]; label: string }[] = [
    { value: "deployment", label: "Deployment" },
    { value: "recovery", label: "Recovery" },
    { value: "debugshare", label: "DEBUGSHARE" },
    { value: "amp-task", label: "Owner Amp task" },
    { value: "coding", label: "Coding" },
  ];
  $effect(() => {
    query = operations.query;
    source = operations.source;
  });
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });
  const label = (value: OperationEvent["source"]) =>
    sources.find((item) => item.value === value)?.label ?? "Controller";
  const href = (id: string) => `/operations?id=${encodeURIComponent(id)}`;
  const threadHref = (id: string) =>
    `https://ampcode.com/threads/${encodeURIComponent(id)}`;
  const tone = (event: OperationEvent) =>
    event.failure
      ? "state-danger"
      : ["unknown", "blocked", "needs_review", "awaiting_approval"].includes(
            event.status,
          )
        ? "state-warn"
        : "state-neutral";
  const outcome = (event: OperationEvent) =>
    ["completed", "reconciled", "failed", "rolled_back", "superseded"].includes(
      event.status,
    )
      ? "Recorded outcome"
      : "Latest recorded state";
  function age(at: number) {
    const seconds = Math.floor((now - at) / 1000);
    if (seconds < 0) return "ahead of this browser’s clock";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400)
      return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
  async function select(event: MouseEvent, id: string) {
    if (
      event.button ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    listOpen = false;
    onselect(id);
    await tick();
    detailHeading?.focus({ preventScroll: true });
    if (matchMedia("(max-width: 800px)").matches)
      detailHeading?.scrollIntoView({ block: "start" });
  }
  function search(failureKey = operations.failureKey) {
    onsearch({ query, source, failureKey, offset: 0 });
  }
  async function allMatches(summary: OperationSummary) {
    listOpen = true;
    onsearch({
      query: "",
      source: "",
      failureKey: summary.failureKey ?? "",
      offset: 0,
    });
    await tick();
    resultsHeading?.focus({ preventScroll: true });
    if (matchMedia("(max-width: 800px)").matches)
      resultsHeading?.scrollIntoView({ block: "start" });
  }
</script>

{#snippet status(event: OperationEvent)}
  <Badge variant="outline" class={`state-badge ${tone(event)}`}
    >{event.status.replaceAll("_", " ")}</Badge
  >
{/snippet}

{#snippet links(event: OperationEvent, showMissing = false)}
  <div class="operation-links">
    {#if event.threadId}<a
        href={threadHref(event.threadId)}
        target="_blank"
        rel="noreferrer"
        >Amp thread <code>{event.threadId.slice(0, 10)}</code><ArrowUpRight
          size={13}
          aria-hidden="true"
        /></a
      >
    {:else if showMissing}<span class="muted"
        >No Amp thread in latest event</span
      >{/if}
    {#if event.snapshotId}<a href={`/s/${encodeURIComponent(event.snapshotId)}`}
        >Capture <code>{event.snapshotId.slice(0, 8)}</code></a
      >{/if}
    {#if event.relatedOperationId}<a
        href={href(event.relatedOperationId)}
        onclick={(e) => select(e, event.relatedOperationId!)}
        >Linked operation</a
      >{/if}
  </div>
{/snippet}

{#snippet controllerMetadata(event: OperationEvent)}
  {#if event.controller}
    {@const c = event.controller}
    <dl class="operation-metadata">
      <div>
        <dt>Active revision</dt>
        <dd class="mono">{c.activeRevision ?? "Not recorded"}</dd>
      </div>
      <div>
        <dt>Target revision</dt>
        <dd class="mono">{c.targetRevision ?? "Not recorded"}</dd>
      </div>
      <div>
        <dt>Observed revision</dt>
        <dd class="mono">{c.observedRevision ?? "Not recorded"}</dd>
      </div>
      <div>
        <dt>Controller revision</dt>
        <dd class="mono">{c.controllerRevision ?? "Not recorded"}</dd>
      </div>
      <div>
        <dt>Phase / holds</dt>
        <dd>
          {c.phase ?? "Unknown"} · {c.blocked ? "Blocked" : "Not blocked"} · {c.operatorHold
            ? "Operator hold"
            : "No operator hold"}
        </dd>
      </div>
      <div>
        <dt>Retry attempts / next retry</dt>
        <dd>
          {c.retryAttempts ?? "Unknown"} / {#if c.retryAt !== null}<Time
              value={c.retryAt}
              {utc}
            />{:else}Not recorded{/if}
        </dd>
      </div>
      <div>
        <dt>Recovery owner</dt>
        <dd>
          {#if c.recoveryOwner}<a
              href={threadHref(c.recoveryOwner)}
              target="_blank"
              rel="noreferrer"
              class="mono">{c.recoveryOwner}</a
            >{:else}Not recorded{/if}
        </dd>
      </div>
      <div>
        <dt>Recovery thread</dt>
        <dd>
          {#if c.recoveryThreadId}<a
              href={threadHref(c.recoveryThreadId)}
              target="_blank"
              rel="noreferrer"
              class="mono">{c.recoveryThreadId}</a
            >{:else}Not recorded{/if}
        </dd>
      </div>
      <div>
        <dt>Recovery incident</dt>
        <dd>
          {#if c.recoveryIncident}<a
              href={href(c.recoveryIncident)}
              onclick={(e) => select(e, c.recoveryIncident!)}
              class="mono">{c.recoveryIncident}</a
            >{:else}Not recorded{/if}
        </dd>
      </div>
      <div>
        <dt>Queued revisions</dt>
        <dd>
          {#each c.queuedRevisions as revision}<span
              class="queued-revision mono">{revision}</span
            >{:else}None in this observation{/each}{#if c.omittedQueueCount > 0}<span
              class="queued-revision"
              >{c.omittedQueueCount} additional revisions omitted by source</span
            >{/if}
        </dd>
      </div>
    </dl>
  {/if}
{/snippet}

<div class="operations-heading">
  <div>
    <h1>Operations</h1>
    <p>
      June-controlled Amp triggers and deployment observations. Read-only,
      retained metadata.
    </p>
  </div>
  <Button
    variant="outline"
    onclick={onrefresh}
    disabled={operations.indexBusy || operations.detailBusy}
    ><RefreshCw size={14} aria-hidden="true" />Refresh observations</Button
  >
</div>

<section class="controller-strip" aria-labelledby="controller-heading">
  <div class="operation-section-heading">
    <h2 id="controller-heading">Deployment observation</h2>
    {#if controller}<Badge
        variant="outline"
        class={`state-badge ${stale || clockSkew ? "state-warn" : "state-neutral"}`}
        >{clockSkew
          ? "Clock-skewed observation"
          : stale
            ? "Stale observation"
            : "Recorded observation"}</Badge
      >{/if}
  </div>
  {#if operations.indexBusy}<p class="section-note" role="status">
      Loading the latest archived controller observation…
    </p>
  {:else if operations.indexError}<p class="section-note" role="alert">
      Controller observation unavailable. Refresh to retry; no live state can be
      inferred.
    </p>
  {:else if !controller}<p class="section-note">
      No controller observation received. The source may not be connected or
      publishing yet. This is not a health signal.
    </p>
  {:else}
    <p class="controller-time">
      Observed <Time value={controller.observedAt} {utc} />
      <span>({age(controller.observedAt)})</span>. {clockSkew
        ? "Timestamp ahead of this browser; current controller state is unknown."
        : stale
          ? "Over 5 minutes old; this may no longer describe the controller."
          : "An archived observation, not a live health check."}
    </p>
    {#if control}
      <dl class="controller-facts">
        <div>
          <dt>Recorded state / phase</dt>
          <dd>
            {controller.status.replaceAll("_", " ")} /
            <code>{control.phase ?? "unknown"}</code>
          </dd>
        </div>
        <div>
          <dt>Holds</dt>
          <dd>
            {control.blocked ? "Blocked" : "Not blocked"} · {control.operatorHold
              ? "Operator hold"
              : "No operator hold"}
          </dd>
        </div>
        <div>
          <dt>Retries</dt>
          <dd>
            {control.retryAttempts ?? "Unknown"} attempts · {#if control.retryAt !== null}next
              <Time value={control.retryAt} {utc} />{:else}next retry not
              recorded{/if}
          </dd>
        </div>
        <div>
          <dt>Recovery owner</dt>
          <dd>
            {#if control.recoveryOwner}<a
                href={threadHref(control.recoveryOwner)}
                target="_blank"
                rel="noreferrer"
                class="mono">{control.recoveryOwner}</a
              >{:else}Not recorded{/if}
          </dd>
        </div>
      </dl>
      <details class="controller-details">
        <summary
          >Revisions, queue &amp; recovery links · {control.queuedRevisions
            .length + control.omittedQueueCount} queued</summary
        >{@render controllerMetadata(controller)}
      </details>
    {:else}<p class="section-note">
        Controller fields were not recorded with this event.
      </p>{/if}
    <div class="controller-links">
      <span>Event time: <Time value={controller.occurredAt} {utc} /></span><a
        href={href(controller.operationId)}
        onclick={(e) => select(e, controller.operationId)}
        >Controller timeline</a
      >
    </div>
  {/if}
</section>

<form
  class="operation-filters"
  onsubmit={(event) => {
    event.preventDefault();
    search();
  }}
>
  <div class="operation-query">
    <label for="operations-query">Search retained metadata</label>
    <div>
      <Input
        id="operations-query"
        placeholder="ID, revision, status, phase or reason…"
        bind:value={query}
        maxlength={512}
        autocomplete="off"
      /><Button
        type="submit"
        variant="outline"
        size="icon"
        aria-label="Search operations"
        disabled={operations.indexBusy}><Search size={15} /></Button
      >
    </div>
  </div>
  <div class="operation-source">
    <label for="operations-source">Source</label><select
      id="operations-source"
      bind:value={source}
      onchange={() => search()}
      ><option value="">All sources</option>{#each sources as item}<option
          value={item.value}>{item.label}</option
        >{/each}</select
    >
  </div>
  {#if operations.query || operations.source || operations.failureKey}<Button
      variant="ghost"
      onclick={() => onsearch({})}>Clear filters</Button
    >{/if}
</form>
<div class="operation-search-note">
  <p>
    Search covers all retained metadata, including earlier failures. Controller
    observations appear above.
  </p>
  {#if operations.failureKey}<p>
      Symptom filter: <code>{operations.failureKey}</code><Button
        variant="ghost"
        size="sm"
        onclick={() => search("")}>Remove symptom filter</Button
      >
    </p>{/if}
</div>

<div class="operations-workbench">
  <section class="operations-list-panel" aria-label="Operation results">
    <div class="operation-results-heading">
      <h2 tabindex="-1" bind:this={resultsHeading}>Operations</h2>
      <span role="status"
        >{#if operations.index}{operations.index.items.length
            ? `${operations.offset + 1}–${operations.offset + operations.index.items.length} of `
            : ""}{operations.index.total.toLocaleString()}{:else}—{/if}</span
      >
    </div>
    <Button
      class="operations-list-toggle"
      variant="outline"
      aria-expanded={listOpen || !operations.selectedId}
      aria-controls="operations-list"
      onclick={() => {
        listOpen = !listOpen;
      }}
      ><ListFilter size={14} />{listOpen || !operations.selectedId
        ? "Operation list"
        : "Browse operations"}</Button
    >
    <div
      id="operations-list"
      class:list-collapsed={operations.selectedId !== null && !listOpen}
    >
      {#if operations.indexBusy}<Loading compact label="Loading operations…" />
      {:else if operations.indexError}<div class="rail-empty" role="alert">
          <h3>Operations unavailable</h3>
          <p>
            The archive could not return this list. No operation has been
            changed.
          </p>
          <Button variant="outline" onclick={() => onsearch(operations)}
            >Retry list</Button
          >
        </div>
      {:else if !operations.index?.items.length}<div class="rail-empty">
          <h3>
            {operations.query || operations.source || operations.failureKey
              ? "No matching operations"
              : "No operations archived yet"}
          </h3>
          <p>
            {operations.query || operations.source || operations.failureKey
              ? "Try another search or clear the filters. Your selected operation stays open."
              : "Connected sources publish observations here. No records does not mean no activity or a healthy deployment."}
          </p>
          {#if operations.query || operations.source || operations.failureKey}<Button
              variant="outline"
              onclick={() => onsearch({})}>Show all operations</Button
            >{/if}
        </div>
      {:else}
        <nav class="operation-list" aria-label="Retained operations">
          {#each operations.index.items as item (item.latest.operationId)}
            <a
              href={href(item.latest.operationId)}
              class:current={operations.selectedId === item.latest.operationId}
              aria-current={operations.selectedId === item.latest.operationId
                ? "page"
                : undefined}
              onclick={(e) => select(e, item.latest.operationId)}
            >
              <div class="operation-row-top">
                <strong>{label(item.latest.source)}</strong>{@render status(
                  item.latest,
                )}
              </div>
              <code class="operation-id">{item.latest.operationId}</code>
              <p class="operation-row-phase">
                {item.latest.phase ??
                  "Phase unknown"}{#if item.latest.reason}{" · "}{item.latest
                    .reason}{/if}
              </p>
              <p class="operation-row-meta">
                Observed <Time value={item.lastObservedAt} {utc} compact /> · {item.eventCount}
                {item.eventCount === 1 ? "event" : "events"}
              </p>
              <p class="operation-row-meta">
                {item.latest.threadId
                  ? "Amp thread recorded"
                  : "No Amp thread in latest event"}{#if item.failureKey}{" · "}{item.matchingFailures}
                  symptom {item.matchingFailures === 1
                    ? "match"
                    : "matches"}{/if}
              </p>
            </a>
          {/each}
        </nav>
        <div class="archive-pagination">
          <Button
            variant="outline"
            size="sm"
            disabled={operations.offset === 0}
            onclick={() =>
              onsearch({
                ...operations,
                offset: Math.max(0, operations.offset - 50),
              })}><ChevronLeft size={14} />Newer</Button
          ><Button
            variant="outline"
            size="sm"
            disabled={operations.index.nextOffset === null}
            onclick={() =>
              onsearch({
                ...operations,
                offset: operations.index?.nextOffset ?? 0,
              })}>Older<ChevronRight size={14} /></Button
          >
        </div>
      {/if}
    </div>
  </section>

  <section class="operation-detail" aria-labelledby="operation-detail-heading">
    <h2
      id="operation-detail-heading"
      class="operation-detail-label"
      tabindex="-1"
      bind:this={detailHeading}
    >
      Selected operation
    </h2>
    {#if operations.detailBusy}<Loading label="Loading operation timeline…" />
    {:else if operations.detailError}<div
        class="empty-state inline-empty"
        role="alert"
      >
        <h3>
          {operations.detailError === "missing"
            ? "Operation not available yet"
            : "Operation could not be loaded"}
        </h3>
        <p>
          {operations.detailError === "missing"
            ? "This ID is not in the retained archive. Publication may still be pending, or this archive may not contain it."
            : "The archive could not return this timeline. Retry the read without repeating the underlying operation."}
        </p>
        <Button
          variant="outline"
          onclick={() => onevents(operations.eventOffset)}
          >Retry timeline</Button
        >
      </div>
    {:else if detail}
      {@const latest = detail.operation.latest}
      <div class="operation-detail-heading">
        <h3>{label(latest.source)}</h3>
        {@render status(latest)}
      </div>
      <p class="operation-detail-id mono">{latest.operationId}</p>
      <p class="operation-outcome">
        {outcome(latest)}:
        <strong>{latest.status.replaceAll("_", " ")}</strong
        >{#if latest.phase ?? latest.controller?.phase}{" · "}<code
            >{latest.phase ?? latest.controller?.phase}</code
          >{/if}{#if latest.reason}{" · "}<code>{latest.reason}</code>{/if}
      </p>
      {@render links(latest, true)}
      <p class="section-note">
        First observed <Time value={detail.operation.firstObservedAt} {utc} />.
        Last observed <Time value={detail.operation.lastObservedAt} {utc} />.
      </p>
      {#if operations.index && !operations.index.items.some((item) => item.latest.operationId === latest.operationId)}<p
          class="section-note"
        >
          This selection is not on the current results page. Filtering and
          refresh do not change it.
        </p>{/if}
      <section class="related-history" aria-labelledby="related-heading">
        <div class="operation-section-heading">
          <h3 id="related-heading">Matching symptom history</h3>
          {#if detail.operation.failureKey}<Button
              variant="outline"
              size="sm"
              onclick={() => allMatches(detail.operation)}
              >Show all {detail.operation.matchingFailures} matches</Button
            >{/if}
        </div>
        <p class="section-note">
          Same source, phase and reason/status—not proof of the same root cause.
          A completed Amp thread does not verify recovery.
        </p>
        {#if detail.operation.failureKey}
          <p class="symptom-summary">
            <code>{detail.operation.failureKey}</code><span
              >{detail.operation.matchingFailures} distinct {detail.operation
                .matchingFailures === 1
                ? "operation"
                : "operations"}, including this one. Up to 10 other matches
              below.</span
            >
          </p>
          {#each detail.related as item (item.latest.operationId)}
            <div class="related-operation">
              <div class="operation-row-top">
                <a
                  class="mono"
                  href={href(item.latest.operationId)}
                  onclick={(e) => select(e, item.latest.operationId)}
                  >{item.latest.operationId}</a
                >{@render status(item.latest)}
              </div>
              <p>
                {outcome(item.latest)}: {item.latest.status.replaceAll(
                  "_",
                  " ",
                )} · last observed <Time
                  value={item.lastObservedAt}
                  {utc}
                  compact
                />
              </p>
              {@render links(
                item.latest,
              )}{#if item.failure && (item.failure.threadId !== item.latest.threadId || item.failure.snapshotId !== item.latest.snapshotId)}{@render links(
                  item.failure,
                )}{/if}
            </div>
          {:else}<p class="section-note">
              No other operation with this symptom is retained.
            </p>{/each}
        {:else}<p class="section-note">
            No failure marker was recorded for this operation. No symptom match
            can be established.
          </p>{/if}
      </section>
      <section class="operation-events" aria-labelledby="timeline-heading">
        <div class="operation-section-heading">
          <h3 id="timeline-heading">Immutable timeline</h3>
          <span class="muted"
            >{detail.totalEvents.toLocaleString()}
            {detail.totalEvents === 1 ? "event" : "events"}</span
          >
        </div>
        <p class="section-note">
          Newest sequence first. Event time comes from the source; observation
          time is when the record was observed. Unknown times are not
          reconstructed.
        </p>
        <ol class="operation-timeline">
          {#each detail.events as event (event.id)}
            <li>
              <div class="operation-row-top">
                <span class="event-sequence mono">#{event.sequence}</span
                >{@render status(event)}<span class="operation-event-phase"
                  >{event.phase ??
                    event.controller?.phase ??
                    "Phase unknown"}{#if event.reason}{" · "}{event.reason}{/if}</span
                >{#if event.failure}<span class="muted">Failure marker</span
                  >{/if}
              </div>
              <dl class="operation-event-times">
                <div>
                  <dt>Event time</dt>
                  <dd><Time value={event.occurredAt} {utc} /></dd>
                </div>
                <div>
                  <dt>Observed</dt>
                  <dd><Time value={event.observedAt} {utc} /></dd>
                </div>
              </dl>
              {@render links(event)}
              <details class="event-metadata">
                <summary>Event metadata</summary>
                <dl class="operation-metadata">
                  <div>
                    <dt>Event ID</dt>
                    <dd class="mono">{event.id}</dd>
                  </div>
                  <div>
                    <dt>Revision</dt>
                    <dd class="mono">{event.revision ?? "Not recorded"}</dd>
                  </div>
                  <div>
                    <dt>Attempt</dt>
                    <dd>{event.attempt ?? "Not recorded"}</dd>
                  </div>
                  <div>
                    <dt>Retry at</dt>
                    <dd>
                      {#if event.retryAt !== undefined}<Time
                          value={event.retryAt}
                          {utc}
                        />{:else}Not recorded{/if}
                    </dd>
                  </div>
                  {#if event.threadId}<div>
                      <dt>Amp thread ID</dt>
                      <dd class="mono">{event.threadId}</dd>
                    </div>{/if}{#if event.snapshotId}<div>
                      <dt>Capture ID</dt>
                      <dd class="mono">{event.snapshotId}</dd>
                    </div>{/if}
                </dl>
                {@render controllerMetadata(event)}
              </details>
            </li>
          {/each}
        </ol>
        <div class="operation-event-pagination">
          <span
            >{detail.events.length
              ? operations.eventOffset + 1
              : 0}–{operations.eventOffset + detail.events.length} of {detail.totalEvents}</span
          >
          <div class="inline-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={operations.eventOffset === 0}
              onclick={() =>
                onevents(Math.max(0, operations.eventOffset - 100))}
              ><ChevronLeft size={14} />Newer events</Button
            ><Button
              variant="outline"
              size="sm"
              disabled={detail.nextOffset === null}
              onclick={() => onevents(detail.nextOffset ?? 0)}
              >Older events<ChevronRight size={14} /></Button
            >
          </div>
        </div>
      </section>
    {:else}<div class="empty-state inline-empty">
        <h3>Select an operation</h3>
        <p>
          Inspect its recorded states, immutable timeline and matching symptom
          history. Queued and unknown attempts remain visible even without an
          Amp thread.
        </p>
      </div>{/if}
  </section>
</div>
