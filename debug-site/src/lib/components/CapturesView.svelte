<script lang="ts">
  import { ChevronLeft, ChevronRight, RotateCw, Search } from "@lucide/svelte";
  import type { ArchiveState } from "$lib/archive.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { kilobytes, link } from "$lib/display.js";
  import type { Route } from "$lib/route.js";
  import Loading from "./Loading.svelte";
  import Time from "./Time.svelte";

  let {
    route,
    state: archive,
    utc,
    onnavigate,
    onretry,
  }: {
    route: Extract<Route, { view: "captures" }>;
    state: ArchiveState;
    utc: boolean;
    onnavigate: (route: Route) => void;
    onretry: () => void;
  } = $props();
  let query = $state("");
  const nav = (next: Route) => link(next, onnavigate);
  const index = $derived(archive.index);
  $effect(() => {
    query = route.query;
  });
  const page = (offset: number) =>
    onnavigate({ view: "captures", query: route.query, offset });
</script>

<div class="page-head">
  <div>
    <h1>Captures</h1>
    <p>
      Uploaded DEBUG and DEBUGSHARE evidence. Search covers retained capture
      metadata across the whole archive, not only this page.
    </p>
  </div>
</div>

<form
  class="toolbar"
  role="search"
  onsubmit={(event) => {
    event.preventDefault();
    onnavigate({ view: "captures", query: query.trim(), offset: 0 });
  }}
>
  <div class="toolbar-search">
    <Search size={15} aria-hidden="true" />
    <label class="sr-only" for="capture-query">Search the capture archive</label
    >
    <Input
      id="capture-query"
      placeholder="Capture ID, session, revision or reported reason…"
      bind:value={query}
      maxlength={512}
      autocomplete="off"
    />
  </div>
  <Button type="submit" variant="outline" disabled={archive.indexBusy}
    >Search</Button
  >
  {#if route.query}<Button
      variant="ghost"
      onclick={() => {
        query = "";
        onnavigate({ view: "captures", query: "", offset: 0 });
      }}>Clear search</Button
    >{/if}
</form>

<section class="panel" aria-labelledby="capture-results">
  <header class="panel-head">
    <h2 id="capture-results">
      {route.query ? "Matching captures" : "Archived captures"}
    </h2>
    <span class="panel-meta" role="status"
      >{#if index}{index.items.length
          ? `${route.offset + 1}–${route.offset + index.items.length} of `
          : ""}{index.total.toLocaleString()}{:else if archive.indexBusy}Reading…{/if}</span
    >
  </header>
  {#if archive.indexBusy}<Loading compact label="Reading captures…" />
  {:else if archive.indexError}<div class="panel-note" role="alert">
      <p>The capture archive could not be read.</p>
      <Button variant="outline" size="sm" onclick={onretry}
        ><RotateCw size={13} aria-hidden="true" />Retry</Button
      >
    </div>
  {:else if !index?.items.length}<div class="panel-note">
      <p>
        {route.query
          ? "No capture metadata matches this search."
          : "Captures appear here after they are uploaded to this archive."}
      </p>
    </div>
  {:else}
    <div class="table-wrap">
      <table class="data-table selectable">
        <thead
          ><tr
            ><th scope="col">Capture</th><th scope="col">Reported reason</th><th
              scope="col"
              class="col-optional">Session</th
            ><th scope="col" class="col-optional">Mode</th><th scope="col"
              >Captured</th
            ><th scope="col" class="num col-optional">Size</th></tr
          ></thead
        >
        <tbody>
          {#each index.items as item (item.id)}
            <tr
              class:current={archive.selectedId === item.id}
              aria-current={archive.selectedId === item.id ? "true" : undefined}
            >
              <td
                ><a
                  class="mono"
                  title={item.id}
                  {...nav({ view: "capture", id: item.id, page: "evidence" })}
                  >{item.id.slice(0, 8)}</a
                >{#if archive.selectedId === item.id}<span class="cell-sub"
                    >Last opened</span
                  >{/if}</td
              >
              <td class="cell-reason" title={item.reason}
                >{item.reason || "No reason provided"}</td
              >
              <td class="col-optional mono cell-clip" title={item.sessionId}
                >{item.sessionId}</td
              >
              <td class="col-optional"
                >{item.snapshotOnly ? "DEBUG" : "DEBUGSHARE / historical"}</td
              >
              <td><Time value={item.capturedAt} {utc} compact /></td>
              <td class="num col-optional">{kilobytes(item.bytes)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="list-foot">
      <Button
        variant="outline"
        size="sm"
        disabled={route.offset === 0}
        onclick={() => page(Math.max(0, route.offset - 50))}
        ><ChevronLeft size={14} />Newer</Button
      ><Button
        variant="outline"
        size="sm"
        disabled={index.nextOffset === null}
        onclick={() => page(index?.nextOffset ?? 0)}
        >Older<ChevronRight size={14} /></Button
      >
    </div>
  {/if}
</section>
<p class="page-foot">
  Private, uploaded evidence. Reading it does not contact June, and a stored
  capture is not proof that June is live or that an investigation succeeded.
</p>
