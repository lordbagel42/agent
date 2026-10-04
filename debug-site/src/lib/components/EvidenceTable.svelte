<script lang="ts">
  import {
    ArrowRight,
    ChevronLeft,
    ChevronRight,
    Search,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { filterRows, pageItems, type EvidenceRow } from "$lib/projection.js";
  import JsonViewer from "./JsonViewer.svelte";
  import Status from "./Status.svelte";
  import Time from "./Time.svelte";
  let {
    rows,
    label,
    utc,
  }: { rows: EvidenceRow[]; label: string; utc: boolean } = $props();
  const id = $props.id();
  let query = $state("");
  let page = $state(0);
  let selected = $state("");
  const filtered = $derived(filterRows(rows, query));
  const visible = $derived(pageItems(filtered, page));
  const current = $derived(
    visible.items.find((row) => row.path === selected) ?? visible.items[0],
  );
</script>

<div class="evidence-toolbar">
  <form class="evidence-filter" onsubmit={(event) => event.preventDefault()}>
    <Search size={15} aria-hidden="true" />
    <label class="sr-only" for={`${id}-filter`}
      >Filter {label.toLowerCase()} in this capture</label
    >
    <Input
      id={`${id}-filter`}
      placeholder={`Filter ${label.toLowerCase()} in this capture…`}
      bind:value={query}
      oninput={() => (page = 0)}
      autocomplete="off"
    />
  </form>
  <span class="muted" role="status"
    >{filtered.length.toLocaleString()} / {rows.length.toLocaleString()} records</span
  >
</div>
<div class="evidence-workbench">
  <section class="evidence-list" aria-label={label}>
    {#if !visible.items.length}
      <div class="empty-state inline-empty">
        <h3>
          {query
            ? "No matching evidence"
            : `No ${label.toLowerCase()} retained`}
        </h3>
        <p>
          {query
            ? "Try a different filter. Archive search is separate."
            : "Absence in this capture is not proof that nothing happened. Check Capture scope and Raw data."}
        </p>
        {#if query}<Button variant="outline" onclick={() => (query = "")}
            >Clear filter</Button
          >{/if}
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus enables horizontal and vertical table scrolling.) -->
      <div
        class="table-scroll"
        tabindex="0"
        role="region"
        aria-label={`${label} table, scroll horizontally if needed`}
      >
        <table>
          <thead
            ><tr
              ><th scope="col">Evidence</th><th scope="col">Recorded state</th
              ><th scope="col">Timestamp</th></tr
            ></thead
          >
          <tbody>
            {#each visible.items as row (row.path)}
              <tr class:selected={current?.path === row.path}>
                <td
                  ><button
                    class="evidence-select"
                    onclick={() => (selected = row.path)}
                    aria-pressed={current?.path === row.path}
                    aria-controls={`${id}-inspector`}
                  >
                    <span class="row-kind"
                      >{row.kind}<ArrowRight
                        size={13}
                        aria-hidden="true"
                      /></span
                    >
                    <span class="row-title">{row.title.slice(0, 240)}</span>
                    <span class="row-source">{row.source}</span>
                  </button></td
                >
                <td><Status value={row.status} /></td>
                <td class="timestamp-cell"
                  ><Time value={row.time} {utc} compact /><span
                    class="row-source"
                    >{row.time === null ? "Not retained" : row.timeLabel}</span
                  ></td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="table-footer">
        <span
          >Page {visible.page + 1} of {visible.pages} · 40 records per page</span
        >
        <div class="inline-actions">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Previous ${label.toLowerCase()} page`}
            disabled={visible.page === 0}
            onclick={() => (page = visible.page - 1)}
            ><ChevronLeft size={16} /></Button
          >
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Next ${label.toLowerCase()} page`}
            disabled={visible.page + 1 === visible.pages}
            onclick={() => (page = visible.page + 1)}
            ><ChevronRight size={16} /></Button
          >
        </div>
      </div>
    {/if}
  </section>
  <aside
    class="inspector"
    id={`${id}-inspector`}
    aria-label="Selected evidence inspector"
  >
    <div class="inspector-heading">
      <h3>Evidence inspector</h3>
      <span class="muted">Exact retained payload</span>
    </div>
    {#if current}
      <div class="inspector-meta">
        <span>{current.kind} · {current.source}</span><code>{current.path}</code
        ><Time value={current.time} {utc} />
      </div>
      {#key current.path}<JsonViewer
          value={current.payload}
          label="Selected evidence JSON"
        />{/key}
    {:else}<p class="inspector-empty">
        Select a record to inspect its retained JSON.
      </p>{/if}
  </aside>
</div>
