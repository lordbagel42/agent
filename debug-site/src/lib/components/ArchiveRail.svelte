<script lang="ts">
  import { ChevronLeft, ChevronRight, RefreshCw, Search } from "@lucide/svelte";
  import type { ArchiveState } from "$lib/archive.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import Loading from "./Loading.svelte";
  import Time from "./Time.svelte";
  let {
    state: archiveState,
    utc,
    onsearch,
    onselect,
  }: {
    state: ArchiveState;
    utc: boolean;
    onsearch: (query: string, offset: number) => void;
    onselect: (id: string) => void;
  } = $props();
  let query = $state("");
  let previous = $state<number[]>([]);
  const items = $derived(archiveState.index?.items.slice(0, 50) ?? []);
  const nextOffset = $derived(
    archiveState.index && archiveState.index.items.length > 50
      ? archiveState.offset + 50
      : archiveState.index?.nextOffset,
  );
  function search() {
    previous = [];
    onsearch(query, 0);
  }
  function next() {
    if (nextOffset === null || nextOffset === undefined) return;
    previous = [...previous, archiveState.offset];
    onsearch(archiveState.query, nextOffset);
  }
  function back() {
    const offset = previous.at(-1) ?? 0;
    previous = previous.slice(0, -1);
    onsearch(archiveState.query, offset);
  }
</script>

<div class="rail-heading">
  <h2>Recent captures</h2>
  <Button
    variant="ghost"
    size="icon-sm"
    aria-label="Refresh archive"
    onclick={() => onsearch(archiveState.query, archiveState.offset)}
    disabled={archiveState.indexBusy}><RefreshCw size={14} /></Button
  >
</div>
<form
  class="archive-search"
  onsubmit={(event) => {
    event.preventDefault();
    search();
  }}
>
  <label class="sr-only" for="archive-query">Search the archive</label>
  <Input
    id="archive-query"
    placeholder="Search archive…"
    bind:value={query}
    autocomplete="off"
  />
  <Button
    type="submit"
    variant="outline"
    size="icon"
    aria-label="Search archive"
    disabled={archiveState.indexBusy}><Search size={15} /></Button
  >
</form>
<p class="archive-search-hint">Search retained captures, not just this page.</p>
{#if archiveState.indexBusy}<Loading compact label="Loading archive…" />
{:else if archiveState.indexError}<div class="rail-empty" role="alert">
    <h3>Archive unavailable</h3>
    <p>The archive could not be loaded.</p>
    <Button
      variant="outline"
      onclick={() => onsearch(archiveState.query, archiveState.offset)}
      >Retry archive</Button
    >
  </div>
{:else if items.length === 0}<div class="rail-empty">
    <h3>{archiveState.query ? "No matching captures" : "No captures yet"}</h3>
    <p>
      {archiveState.query
        ? "Try another search or clear it to view recent captures."
        : "Captures appear here after they are uploaded to this archive."}
    </p>
    {#if archiveState.query}<Button
        variant="outline"
        onclick={() => {
          query = "";
          search();
        }}>Clear archive search</Button
      >{/if}
  </div>
{:else}
  <div class="archive-count" role="status">
    {archiveState.offset + 1}–{archiveState.offset + items.length} of {archiveState.index?.total.toLocaleString()}
    {archiveState.query ? "matches" : "captures"}
  </div>
  <nav class="capture-list" aria-label="Recent captures">
    {#each items as item (item.id)}
      <a
        href={`/s/${encodeURIComponent(item.id)}`}
        class:current={archiveState.selectedId === item.id}
        aria-current={archiveState.selectedId === item.id ? "page" : undefined}
        onclick={(event) => {
          if (
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            onselect(item.id);
          }
        }}
      >
        <div class="capture-row-top">
          <code>{item.id.slice(0, 8)}</code><Time
            value={item.capturedAt}
            {utc}
            compact
          />
        </div>
        <span class="capture-row-reason"
          >{item.reason || "No reason provided"}</span
        >
        <span class="capture-row-meta"
          >{item.snapshotOnly ? "DEBUG" : "DEBUGSHARE / historical"} · {(
            item.bytes / 1024
          ).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB</span
        >
      </a>
    {/each}
  </nav>
  <div class="archive-pagination">
    <Button
      variant="outline"
      size="sm"
      onclick={back}
      disabled={archiveState.offset === 0}
      ><ChevronLeft size={14} />Newer</Button
    ><Button
      variant="outline"
      size="sm"
      onclick={next}
      disabled={nextOffset == null}>Older<ChevronRight size={14} /></Button
    >
  </div>
{/if}
<p class="rail-footer">
  Private, uploaded evidence.<br />No live connection to June is required.
</p>
