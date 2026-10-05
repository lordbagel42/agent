<script lang="ts">
  import { ChevronLeft, ChevronRight, Search } from "@lucide/svelte";
  import { tick } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import {
    filterRows,
    pageItems,
    record,
    timestamp,
    type EvidenceRow,
  } from "$lib/projection.js";
  import JsonViewer from "./JsonViewer.svelte";
  import Time from "./Time.svelte";

  let { rows, utc }: { rows: EvidenceRow[]; utc: boolean } = $props();
  const id = $props.id();
  const textLimit = 8_000;
  let source = $state("");
  let query = $state("");
  let page = $state(0);
  let inspecting = $state("");
  let transcript = $state<HTMLElement>();
  const coordinator = $derived(
    rows.filter((row) => row.source === "Coordinator"),
  );
  const activity = $derived(rows.filter((row) => row.source === "Activity"));
  const selectedSource = $derived(
    source ||
      (coordinator.length || !activity.length ? "Coordinator" : "Activity"),
  );
  const retained = $derived(
    selectedSource === "Coordinator" ? coordinator : activity,
  );
  const filtered = $derived(filterRows(retained, query));
  const visible = $derived(pageItems(filtered, page, 20));
  async function showPage(next: number) {
    page = next;
    inspecting = "";
    await tick();
    transcript?.focus({ preventScroll: true });
    transcript?.scrollIntoView({ block: "start" });
  }
</script>

<section
  class="conversation"
  aria-label="Retained conversation"
  bind:this={transcript}
  tabindex="-1"
>
  <p class="section-note">
    Read-only history in retained order. Histories can overlap; assistant
    records may summarize outcomes rather than words delivered. Times appear
    only when explicitly retained, not as proof of delivery.
  </p>
  <div class="conversation-toolbar">
    <form class="evidence-filter" onsubmit={(event) => event.preventDefault()}>
      <Search size={15} aria-hidden="true" />
      <label class="sr-only" for={`${id}-filter`}
        >Search conversation records</label
      >
      <Input
        id={`${id}-filter`}
        placeholder="Search messages and records…"
        bind:value={query}
        oninput={() => {
          page = 0;
          inspecting = "";
        }}
        autocomplete="off"
      />
    </form>
    <label class="history-source">
      History source
      <select
        value={selectedSource}
        onchange={(event) => {
          source = event.currentTarget.value;
          page = 0;
          inspecting = "";
        }}
      >
        <option value="Coordinator"
          >Coordinator ({coordinator.length.toLocaleString()})</option
        >
        <option value="Activity"
          >Activity ({activity.length.toLocaleString()})</option
        >
      </select>
    </label>
  </div>

  {#if !visible.items.length}
    <div class="empty-state inline-empty" role="status">
      <h2>{query ? "No matching messages" : "No messages retained"}</h2>
      <p>
        {query
          ? "Try a different search or history source. Search includes the full retained records."
          : "This history is empty or unavailable in this capture. Try the other source or review Capture scope on the Evidence page."}
      </p>
      {#if query}<Button variant="outline" onclick={() => (query = "")}
          >Clear search</Button
        >{/if}
    </div>
  {:else}
    <ol class="conversation-messages" aria-label={`${selectedSource} messages`}>
      {#each visible.items as row (row.path)}
        {@const message = record(row.payload)}
        {@const body = message.content}
        {@const occurredAt = timestamp(record(message.source).occurredAt)}
        {@const position = retained.indexOf(row) + 1}
        <li class:user={row.status === "user"}>
          <div class="message-heading">
            <h2>
              {row.status === "user"
                ? "User"
                : row.status === "assistant"
                  ? "Assistant"
                  : row.status}
            </h2>
            <span>#{position}</span>
            {#if occurredAt !== null}<span class="message-time"
                >Source time · <Time value={occurredAt} {utc} compact /></span
              >{/if}
          </div>
          <div class="message-body">
            {#if typeof body === "string" && body.length}<p>
                {body.slice(0, textLimit)}
              </p>
              {#if body.length > textLimit}<p class="field-hint">
                  Showing the first {textLimit.toLocaleString()} characters. Inspect
                  the record or export JSON for the full text.
                </p>{/if}
            {:else}<p class="muted">
                {body === ""
                  ? "Empty message retained."
                  : "Non-text record. Inspect the original payload below."}
              </p>{/if}
          </div>
          <details
            open={inspecting === row.path}
            ontoggle={(event) => {
              if (event.currentTarget.open) inspecting = row.path;
              else if (inspecting === row.path) inspecting = "";
            }}
          >
            <summary
              >Inspect record <span class="sr-only">{position}</span></summary
            >
            {#if inspecting === row.path}
              <div class="message-record">
                <p>Exact retained payload · {row.source}</p>
                <code>{row.path}</code>
                <JsonViewer
                  value={row.payload}
                  label={`Message ${position} JSON`}
                />
              </div>
            {/if}
          </details>
        </li>
      {/each}
    </ol>
  {/if}
  <div class="table-footer">
    <span role="status"
      >{filtered.length.toLocaleString()} / {retained.length.toLocaleString()} records
      · Page {visible.page + 1} of {visible.pages}</span
    >
    <div class="inline-actions">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous conversation page"
        disabled={visible.page === 0}
        onclick={() => showPage(visible.page - 1)}
        ><ChevronLeft size={16} /></Button
      >
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next conversation page"
        disabled={visible.page + 1 === visible.pages}
        onclick={() => showPage(visible.page + 1)}
        ><ChevronRight size={16} /></Button
      >
    </div>
  </div>
</section>

<style>
  .conversation {
    max-width: 960px;
  }
  .conversation-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .history-source {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted-text);
    font-size: 0.79rem;
  }
  select {
    min-height: 34px;
    min-width: 0;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    padding: 5px 8px;
    background: var(--inset);
    color: var(--foreground);
  }
  .conversation-messages {
    list-style: none;
    margin: 0;
    padding: 28px 0;
    display: flex;
    flex-direction: column;
    gap: 28px;
  }
  li {
    min-width: 0;
    width: 85%;
    max-width: 75ch;
    align-self: flex-start;
  }
  li.user {
    align-self: flex-end;
  }
  .message-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    color: var(--muted-text);
    font-size: 0.79rem;
    margin-bottom: 8px;
    overflow-wrap: anywhere;
  }
  .message-heading h2 {
    color: var(--foreground);
    font-size: 0.86rem;
  }
  .message-time {
    margin-left: auto;
  }
  .message-body {
    line-height: 1.7;
    overflow-wrap: anywhere;
  }
  .message-body p {
    white-space: pre-wrap;
  }
  .message-body .field-hint {
    margin-top: 12px;
  }
  .user .message-body {
    background: var(--raised);
    padding: 12px 16px;
    border-radius: 12px;
  }
  summary {
    width: fit-content;
    padding: 8px 0;
    color: var(--muted-text);
    cursor: pointer;
    font-size: 0.79rem;
  }
  summary:hover {
    color: var(--foreground);
  }
  .message-record {
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
  }
  .message-record > p {
    padding: 12px 12px 4px;
    font-size: 0.79rem;
    color: var(--muted-text);
  }
  .message-record > code {
    display: block;
    padding: 0 12px 12px;
    overflow-wrap: anywhere;
  }
  @media (max-width: 800px) {
    .conversation-toolbar {
      align-items: stretch;
      flex-direction: column;
      gap: 10px;
    }
    .conversation-toolbar .evidence-filter {
      width: 100%;
    }
    .history-source {
      justify-content: space-between;
    }
    select,
    summary {
      min-height: 44px;
    }
    summary {
      padding-block: 12px;
    }
    li {
      width: 95%;
    }
    .conversation-messages {
      gap: 20px;
    }
  }
</style>
