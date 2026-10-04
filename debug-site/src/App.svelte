<script lang="ts">
  import { Archive, ChevronDown, LockKeyhole, LogOut } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { createArchive } from "$lib/archive.js";
  import ArchiveRail from "$lib/components/ArchiveRail.svelte";
  import CaptureView from "$lib/components/CaptureView.svelte";
  import Loading from "$lib/components/Loading.svelte";
  import Login from "$lib/components/Login.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  const archive = createArchive();
  let railOpen = $state(false);
  let zone = $state("local");
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utc = $derived(zone === "utc");
  function routeId() {
    const match = /^\/s\/([^/]+)\/?$/.exec(location.pathname);
    try {
      return match?.[1] ? decodeURIComponent(match[1]) : null;
    } catch {
      return "invalid-capture-id";
    }
  }
  function navigate(id: string | null) {
    history.pushState(null, "", id ? `/s/${encodeURIComponent(id)}` : "/");
    railOpen = false;
    void archive.select(id);
  }
  async function download() {
    const result = await archive.download();
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `june-debug-${result.id.replace(/[^a-zA-Z0-9-]/g, "_")}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  onMount(() => {
    void archive.start(routeId());
    const pop = () => {
      railOpen = false;
      if ($archive.phase === "ready") void archive.select(routeId());
    };
    // A restored browser history document must re-check its private session.
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) void archive.start(routeId());
    };
    const hide = () => archive.clear();
    window.addEventListener("popstate", pop);
    window.addEventListener("pageshow", show);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("pagehide", hide);
      archive.clear();
    };
  });
</script>

<a class="skip-link" href="#capture-main">Skip to capture</a>
<header class="app-header">
  <a
    class="brand"
    href="/"
    onclick={(event) => {
      if ($archive.phase === "ready" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        navigate(null);
      }
    }}
    ><span>June</span><span class="brand-divider" aria-hidden="true">/</span
    ><span>Debug</span></a
  >
  <div class="header-actions">
    <span class="private-indicator"
      ><LockKeyhole size={13} aria-hidden="true" />Private archive</span
    >{#if $archive.phase === "ready"}<Button
        variant="ghost"
        onclick={() => archive.logout()}><LogOut size={14} />Sign out</Button
      >{/if}
  </div>
</header>

{#if $archive.phase === "checking"}
  <main id="capture-main">
    <Loading label="Checking your private session…" />
  </main>
{:else if $archive.phase === "login"}
  <main id="capture-main">
    <Login
      busy={$archive.loginBusy}
      error={$archive.loginError}
      notice={$archive.notice}
      signoutError={$archive.actionError}
      onlogin={(token) => archive.login(token, routeId())}
      onlogout={() => archive.logout()}
    />
  </main>
{:else if $archive.phase === "error"}
  <main id="capture-main" class="empty-state">
    <h1>Archive connection unavailable</h1>
    <p>Your session could not be checked. No captured data has been loaded.</p>
    <Button variant="outline" onclick={() => archive.start(routeId())}
      >Retry connection</Button
    >
  </main>
{:else}
  <div class="app-workspace">
    <div class="mobile-rail-toggle">
      <Button
        variant="outline"
        aria-expanded={railOpen}
        aria-controls="archive-rail"
        onclick={() => (railOpen = !railOpen)}
        ><Archive size={15} />Recent captures<ChevronDown size={15} /></Button
      >
    </div>
    <aside
      id="archive-rail"
      class:rail-open={railOpen}
      class="archive-rail"
      aria-label="Capture archive"
    >
      <ArchiveRail
        state={$archive}
        {utc}
        onsearch={(query, offset) => archive.search(query, offset)}
        onselect={navigate}
      />
    </aside>
    <main id="capture-main" class="capture-main">
      <div class="workspace-toolbar">
        <span>Diagnostic evidence</span><label class="timezone-control"
          >Times<select aria-label="Timestamp timezone" bind:value={zone}
            ><option value="local">Local · {localZone}</option><option
              value="utc">UTC</option
            ></select
          ></label
        >
      </div>
      {#if $archive.captureBusy}<Loading />
      {:else if $archive.captureError}
        <div class="empty-state" role="alert">
          <h1>
            {$archive.captureError === "missing"
              ? "Capture not available yet"
              : "Capture could not be loaded"}
          </h1>
          <p>
            {$archive.captureError === "missing"
              ? "This capture is not in the archive. The upload may still be pending, or this archive may not contain it. Retry without creating a new capture."
              : "The archive could not return this capture. Try again; no evidence has been changed."}
          </p>
          <Button
            variant="outline"
            onclick={() => archive.select($archive.selectedId)}
            >Retry capture</Button
          >
        </div>
      {:else if $archive.snapshot}
        {#key $archive.snapshot.id}<CaptureView
            snapshot={$archive.snapshot}
            {utc}
            downloading={$archive.downloadBusy}
            actionError={$archive.actionError}
            ondownload={download}
          />{/key}
      {:else}
        <div class="empty-state">
          <h1>No captures archived yet</h1>
          <p>
            Uploaded DEBUG captures will appear here. This site can read
            archived evidence without contacting June.
          </p>
          <Button variant="outline" onclick={() => archive.select(null)}
            >Check for captures</Button
          >
        </div>
      {/if}
    </main>
  </div>
{/if}
