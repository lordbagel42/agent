<script lang="ts">
  import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Info,
    RotateCw,
    Search,
    X,
  } from "@lucide/svelte";
  import { tick } from "svelte";
  import type { OperationsState } from "$lib/archive.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { ampSources, link, sourceLabel, statusLabel } from "$lib/display.js";
  import {
    type OperationRoute,
    type OperationScope,
    type OperationSource,
    operationRoute,
    type Route,
    scopeSources,
  } from "$lib/route.js";
  import type { OperationSummary } from "$lib/types.js";
  import ControllerFacts from "./ControllerFacts.svelte";
  import Loading from "./Loading.svelte";
  import OperationInspector from "./OperationInspector.svelte";
  import StateBadge from "./StateBadge.svelte";
  import Time from "./Time.svelte";

  let {
    route,
    state: operations,
    utc,
    onnavigate,
    onevents,
    onretrylist,
    onretrydetail,
  }: {
    route: OperationRoute;
    state: OperationsState;
    utc: boolean;
    onnavigate: (route: Route) => void;
    onevents: (offset: number) => void;
    onretrylist: () => void;
    onretrydetail: () => void;
  } = $props();
  const copy: Record<OperationScope, { title: string; summary: string }> = {
    operations: {
      title: "All operations",
      summary:
        "Every archived deployment, recovery, DEBUGSHARE, owner Amp task and coding operation. Controller observations appear in Deployments.",
    },
    deployments: {
      title: "Deployments",
      summary:
        "Deployment and recovery operations beside the latest archived controller observation. Recorded facts only; nothing here deploys, retries or releases a hold.",
    },
    errors: {
      title: "Errors",
      summary:
        "Operations with at least one recorded failure marker, including failures on operations that later completed or reconciled.",
    },
    amp: {
      title: "Amp",
      summary:
        "DEBUGSHARE, owner Amp task and coding operations. Each operation keeps its own identity, even when thread IDs match or are absent. Completed means execution ended, not that a fix is verified.",
    },
  };
  let query = $state("");
  let listOpen = $state(false);
  let resultsHeading: HTMLElement | undefined = $state();
  let detailRegion: HTMLElement | undefined = $state();
  const filtered = $derived(
    !!(route.query || route.source || route.failureKey),
  );
  const nav = (next: Route) => link(next, onnavigate);
  const withId = (id: string) => operationRoute(route.scope, { ...route, id });
  $effect(() => {
    query = route.query;
  });
  function filter(update: Partial<OperationRoute>) {
    onnavigate(operationRoute(route.scope, { ...route, offset: 0, ...update }));
  }
  async function select(event: MouseEvent, id: string) {
    link(withId(id), onnavigate).onclick(event);
    if (!event.defaultPrevented) return;
    listOpen = false;
    await tick();
    detailRegion?.focus({ preventScroll: true });
    if (matchMedia("(max-width: 800px)").matches)
      detailRegion?.scrollIntoView({ block: "start" });
  }
  function detailLine(item: OperationSummary) {
    const event =
      route.scope === "errors" && item.failure ? item.failure : item.latest;
    return [
      sourceLabel[item.latest.source],
      event.phase,
      event.reason ?? (event.failure ? statusLabel(event.status) : undefined),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  function extraLine(item: OperationSummary) {
    const parts = [
      `${item.eventCount} ${item.eventCount === 1 ? "event" : "events"}`,
    ];
    if (item.failureKey)
      parts.push(
        `${item.matchingFailures} ${item.matchingFailures === 1 ? "operation" : "operations"} with this signature`,
      );
    if (ampSources.has(item.latest.source))
      parts.push(
        item.latest.threadId
          ? "Amp thread recorded"
          : "No thread in latest event",
      );
    if (item.latest.snapshotId)
      parts.push(`capture ${item.latest.snapshotId.slice(0, 8)}`);
    return parts.join(" · ");
  }
</script>

<div class="page-head">
  <div>
    <h1>{copy[route.scope].title}</h1>
    <p>{copy[route.scope].summary}</p>
  </div>
  {#if route.scope !== "operations"}<a
      class="panel-link"
      {...nav(operationRoute("operations", { id: route.id }))}>All operations</a
    >{/if}
</div>

{#if route.scope === "deployments"}
  <ControllerFacts
    controller={operations.controller}
    loading={operations.indexBusy}
    failed={operations.indexError === "failed"}
    {utc}
    {onnavigate}
    onretry={onretrylist}
  />
{:else if route.scope === "errors"}
  <p class="scope-note">
    <Info size={14} aria-hidden="true" />Structured operational errors published
    by June's sources, not raw service-journal coverage. A matching signature
    means the same source, phase and reason; it does not establish the same root
    cause.
  </p>
{/if}

<form
  class="toolbar"
  role="search"
  onsubmit={(event) => {
    event.preventDefault();
    filter({ query: query.trim() });
  }}
>
  <div class="toolbar-search">
    <Search size={15} aria-hidden="true" />
    <label class="sr-only" for="operations-query"
      >Search {copy[route.scope].title.toLowerCase()} metadata</label
    >
    <Input
      id="operations-query"
      placeholder="ID, revision, thread, capture, status, phase or reason…"
      bind:value={query}
      maxlength={512}
      autocomplete="off"
    />
  </div>
  <label class="toolbar-select"
    ><span>Source</span><select
      value={route.source}
      onchange={(event) =>
        filter({
          source: event.currentTarget.value as OperationSource | "",
        })}
      ><option value="">All in {copy[route.scope].title}</option
      >{#each scopeSources[route.scope] as source (source)}<option
          value={source}>{sourceLabel[source]}</option
        >{/each}</select
    ></label
  >
  <Button type="submit" variant="outline" disabled={operations.indexBusy}
    >Search</Button
  >
  {#if route.failureKey}<span class="filter-chip"
      >Signature <code>{route.failureKey}</code><Button
        variant="ghost"
        size="icon-sm"
        aria-label="Remove signature filter"
        onclick={() => filter({ failureKey: "" })}><X size={13} /></Button
      ></span
    >{/if}
  {#if filtered}<Button
      variant="ghost"
      onclick={() => {
        query = "";
        filter({ query: "", source: "", failureKey: "" });
      }}>Clear filters</Button
    >{/if}
</form>

<div class="split" class:has-selection={route.id !== null}>
  <section class="split-list" aria-labelledby="operation-results">
    <header class="list-head">
      <h2 id="operation-results" tabindex="-1" bind:this={resultsHeading}>
        Results
      </h2>
      <span role="status"
        >{#if operations.index}{operations.index.items.length
            ? `${operations.offset + 1}–${operations.offset + operations.index.items.length} of `
            : ""}{operations.index.total.toLocaleString()}{filtered
            ? " matching"
            : ""}{:else if operations.indexBusy}Reading…{:else}—{/if}</span
      >
      <Button
        class="list-toggle"
        variant="ghost"
        size="sm"
        aria-expanded={listOpen}
        aria-controls="operation-rows"
        onclick={() => (listOpen = !listOpen)}
        >{listOpen ? "Hide results" : "Show results"}<ChevronDown
          size={14}
          aria-hidden="true"
        /></Button
      >
    </header>
    <div id="operation-rows" class="list-body" class:list-open={listOpen}>
      {#if operations.indexBusy}<Loading compact label="Reading operations…" />
      {:else if operations.indexError}<div class="panel-note" role="alert">
          <p>Operations could not be read. No operation has been changed.</p>
          <Button variant="outline" size="sm" onclick={onretrylist}
            ><RotateCw size={13} aria-hidden="true" />Retry list</Button
          >
        </div>
      {:else if !operations.index?.items.length}<div class="panel-note">
          <p>
            {filtered
              ? "No archived operation matches these filters. The selected operation stays open."
              : route.scope === "errors"
                ? "No archived operation carries a failure marker. Unpublished sources cannot appear here."
                : "No operations archived yet. No records does not mean no activity or a healthy deployment."}
          </p>
          {#if filtered}<Button
              variant="outline"
              size="sm"
              onclick={() => filter({ query: "", source: "", failureKey: "" })}
              >Clear filters</Button
            >{/if}
        </div>
      {:else}
        <nav class="record-list" aria-label="Archived operations">
          {#each operations.index.items as item (item.latest.operationId)}
            {@const id = item.latest.operationId}
            <a
              href={nav(withId(id)).href}
              class:current={route.id === id}
              aria-current={route.id === id ? "true" : undefined}
              onclick={(event) => select(event, id)}
            >
              <span class="record-main">
                <code class="record-id" title={id}>{id}</code>
                <span class="record-sub">{detailLine(item)}</span>
              </span>
              <span class="record-side">
                <StateBadge event={item.latest} />
                <Time
                  value={route.scope === "errors" && item.failure
                    ? item.failure.observedAt
                    : item.lastObservedAt}
                  {utc}
                  compact
                />
              </span>
              <span class="record-extra">{extraLine(item)}</span>
            </a>
          {/each}
        </nav>
        <div class="list-foot">
          <Button
            variant="outline"
            size="sm"
            disabled={operations.offset === 0}
            onclick={() =>
              onnavigate(
                operationRoute(route.scope, {
                  ...route,
                  offset: Math.max(0, operations.offset - 50),
                }),
              )}><ChevronLeft size={14} />Newer</Button
          ><Button
            variant="outline"
            size="sm"
            disabled={operations.index.nextOffset === null}
            onclick={() =>
              onnavigate(
                operationRoute(route.scope, {
                  ...route,
                  offset: operations.index?.nextOffset ?? 0,
                }),
              )}>Older<ChevronRight size={14} /></Button
          >
        </div>
      {/if}
    </div>
  </section>

  <section
    class="split-detail"
    aria-label="Selected operation"
    tabindex="-1"
    bind:this={detailRegion}
  >
    <OperationInspector
      {route}
      state={operations}
      {utc}
      {onnavigate}
      {onevents}
      onretry={onretrydetail}
      onsignature={(failureKey) => {
        onnavigate(operationRoute("errors", { failureKey, id: route.id }));
        resultsHeading?.focus({ preventScroll: true });
      }}
    />
  </section>
</div>
