<script lang="ts">
  import { ChevronLeft, ChevronRight, Search } from "@lucide/svelte";
  import { tick } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  let { value, label = "JSON evidence" }: { value: unknown; label?: string } =
    $props();
  const id = $props.id();
  const pageSize = 16_000;
  const source = $derived(JSON.stringify(value, null, 2) ?? "null");
  let query = $state("");
  let page = $state(0);
  let found = $state(-1);
  let searched = $state(false);
  let marker = $state<HTMLElement>();
  const pages = $derived(Math.max(1, Math.ceil(source.length / pageSize)));
  const currentPage = $derived(Math.min(page, pages - 1));
  const start = $derived(currentPage * pageSize);
  const chunk = $derived(source.slice(start, start + pageSize));
  const highlight = $derived(
    found >= start && found < start + pageSize ? found - start : -1,
  );
  async function find(backward = false) {
    if (!query) {
      found = -1;
      searched = false;
      return;
    }
    let position = backward
      ? source.lastIndexOf(query, found > 0 ? found - 1 : source.length)
      : source.indexOf(
          query,
          found < 0 ? 0 : found + Math.max(1, query.length),
        );
    if (position === -1)
      position = backward ? source.lastIndexOf(query) : source.indexOf(query);
    found = position;
    searched = true;
    if (position >= 0) page = Math.floor(position / pageSize);
    await tick();
    marker?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
</script>

<section class="json-viewer" aria-label={label}>
  <form
    class="json-search"
    onsubmit={(event) => {
      event.preventDefault();
      find();
    }}
  >
    <label class="sr-only" for={`${id}-query`}
      >Search {label}, case-sensitive</label
    >
    <Search size={14} aria-hidden="true" />
    <Input
      id={`${id}-query`}
      bind:value={query}
      oninput={() => {
        found = -1;
        searched = false;
      }}
      placeholder="Find in JSON…"
      autocomplete="off"
    />
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Previous match"
      disabled={!query}
      onclick={() => find(true)}><ChevronLeft size={14} /></Button
    >
    <Button
      variant="ghost"
      size="icon-sm"
      type="submit"
      aria-label="Next match"
      disabled={!query}><ChevronRight size={14} /></Button
    >
  </form>
  {#if searched}<p class="json-search-result" role="status">
      {found < 0
        ? "No matches in this JSON."
        : `Match at character ${found + 1}. Search wraps; case-sensitive.`}
    </p>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Retained payloads must be keyboard-scrollable.) -->
  <pre tabindex="0" role="region" aria-label={`${label}, scrollable text`}><code
      >{#if highlight < 0}{chunk}{:else}{chunk.slice(0, highlight)}<mark
          bind:this={marker}
          >{chunk.slice(highlight, highlight + query.length)}</mark
        >{chunk.slice(highlight + query.length)}{/if}</code
    ></pre>
  <div class="json-footer">
    <span
      >Characters {source.length ? start + 1 : 0}–{Math.min(
        start + pageSize,
        source.length,
      )} of {source.length.toLocaleString()}</span
    >
    {#if pages > 1}<div class="inline-actions">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous JSON page"
          disabled={currentPage === 0}
          onclick={() => (page = currentPage - 1)}
          ><ChevronLeft size={14} /></Button
        >
        <span>{currentPage + 1} / {pages}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next JSON page"
          disabled={currentPage + 1 === pages}
          onclick={() => (page = currentPage + 1)}
          ><ChevronRight size={14} /></Button
        >
      </div>{/if}
  </div>
  <p class="json-note">
    Search covers the complete JSON. Export JSON includes the full capture.
  </p>
</section>
