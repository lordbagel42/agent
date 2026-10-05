<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import {
    Activity,
    ArrowLeft,
    ArrowUpRight,
    Box,
    Boxes,
    ChevronRight,
    CircleAlert,
    Cpu,
    HardDrive,
    LockKeyhole,
    LogOut,
    Menu,
    Moon,
    RefreshCw,
    Search,
    Server,
    ShieldCheck,
    Sun,
    X,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";
  import * as Tabs from "$lib/components/ui/tabs";
  import ActivityList from "$lib/components/ActivityList.svelte";
  import { timestamp } from "$lib/snapshot";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  let search = $state("");
  let filter = $state("all");
  let refreshing = $state(false);
  let refreshFailed = $state(false);
  let autoRefresh = $state(true);
  let menuOpen = $state(false);
  let light = $state(false);
  const snapshot = $derived(data.snapshot);
  const available = $derived(snapshot?.status === "enabled");
  const view = $derived(page.url.searchParams.get("view") ?? "sandboxes");
  const selectedId = $derived(page.url.searchParams.get("sandbox"));
  const box = $derived(
    snapshot?.boxes.find((entry) => entry.id === selectedId),
  );
  const lease = $derived(
    snapshot?.leases.find((entry) => entry.worker === box?.worker),
  );
  const title = $derived(
    selectedId
      ? "Sandbox details"
      : view === "activity"
        ? "Activity"
        : view === "runtime"
          ? "Runtime"
          : "Sandboxes",
  );
  const statusLabel = $derived(
    refreshFailed
      ? "Refresh failed"
      : !snapshot
        ? "Disconnected"
        : snapshot.status === "enabled"
          ? "Provider enabled"
          : snapshot.status === "disabled"
            ? "Provider disabled"
            : "Inventory unavailable",
  );
  const filtered = $derived(
    (snapshot?.boxes ?? []).filter(
      (entry) =>
        (filter === "all" ||
          (filter === "running" ? entry.running : !entry.running)) &&
        `${entry.id} ${entry.worker} ${entry.image} ${entry.state}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ),
  );
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await invalidateAll();
      refreshFailed = false;
    } catch {
      refreshFailed = true;
    } finally {
      refreshing = false;
    }
  }
  function toggleTheme() {
    light = !light;
    document.documentElement.classList.toggle("dark", !light);
    try {
      localStorage.setItem("sandbox-theme", light ? "light" : "dark");
    } catch {
      /* Theme still works for this visit. */
    }
  }
  onMount(() => {
    light = !document.documentElement.classList.contains("dark");
    const timer = setInterval(() => {
      if (autoRefresh && document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>{title} · June</title></svelte:head>
<a class="skip-link" href="#main">Skip to content</a>
<div class="workspace">
  <aside class:open={menuOpen} class="sidebar">
    <a class="brand" href="/" onclick={() => (menuOpen = false)}
      ><span class="brand-icon"><Box size={20} /></span><strong>June</strong
      ><span class="workspace-tag">workspace</span></a
    >
    <div class="workspace-switch">
      <span class="workspace-avatar">J</span>
      <div>
        <strong>June’s environments</strong><span>Private workspace</span>
      </div>
      <LockKeyhole size={13} />
    </div>
    <nav aria-label="Workspace navigation">
      <a
        href="/"
        class:active={view === "sandboxes"}
        aria-current={view === "sandboxes" ? "page" : undefined}
        onclick={() => (menuOpen = false)}
        ><Boxes size={17} />Sandboxes{#if available}<span class="nav-count"
            >{snapshot?.boxes.length}</span
          >{/if}</a
      >
      <a
        href="/?view=activity"
        class:active={view === "activity"}
        aria-current={view === "activity" ? "page" : undefined}
        onclick={() => (menuOpen = false)}><Activity size={17} />Activity</a
      >
      <a
        href="/?view=runtime"
        class:active={view === "runtime"}
        aria-current={view === "runtime" ? "page" : undefined}
        onclick={() => (menuOpen = false)}><Server size={17} />Runtime</a
      >
    </nav>
    <div class="sidebar-bottom">
      <div class="readonly">
        <ShieldCheck size={16} />
        <div>
          <strong>Observation only</strong>
          <p>Your sandboxes stay untouched.</p>
        </div>
      </div>
      <a href="https://debug.raygen.dev" target="_blank" rel="noreferrer"
        >June Debug<ArrowUpRight size={15} /></a
      >
      <div class="account-row">
        <span class="workspace-avatar small">R</span><span>Owner</span>
        <form method="POST" action="/logout">
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            aria-label="Sign out"><LogOut size={16} /></Button
          >
        </form>
      </div>
    </div>
  </aside>
  <div class="main-column">
    <header class="topbar">
      <Button
        variant="ghost"
        size="icon"
        class="mobile-menu"
        aria-label={menuOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
        >{#if menuOpen}<X size={18} />{:else}<Menu size={18} />{/if}</Button
      ><span class="muted">Workspace</span><ChevronRight size={13} /><span
        >{title}</span
      >
      <div class="topbar-end">
        <Badge variant="outline" class="read-badge"
          ><LockKeyhole size={11} />Read only</Badge
        ><Button
          variant="ghost"
          size="icon"
          aria-label={light ? "Use dark theme" : "Use light theme"}
          onclick={toggleTheme}
          >{#if light}<Moon size={16} />{:else}<Sun size={16} />{/if}</Button
        >
      </div>
    </header>
    <main id="main">
      <div class="page-heading">
        <div>
          {#if selectedId}<a class="back-link" href="/"
              ><ArrowLeft size={13} />All sandboxes</a
            >{/if}
          <h1>{title}</h1>
          <p>
            {selectedId
              ? "Environment metadata, allocations and worker activity."
              : view === "activity"
                ? "The latest events from June’s sandbox runtime."
                : view === "runtime"
                  ? "Provider configuration and execution boundaries."
                  : "Isolated environments for June’s execution workers."}
          </p>
        </div>
        <Button
          variant="outline"
          class="refresh-button"
          disabled={refreshing}
          onclick={refresh}
          ><RefreshCw size={14} class={refreshing ? "spin" : ""} />{refreshing
            ? "Refreshing…"
            : "Refresh"}</Button
        >
      </div>
      <div class="observation-bar">
        <span class="provider-status"
          ><span
            class:good={available && !refreshFailed}
            class:warn={snapshot?.status === "unavailable" ||
              !snapshot ||
              refreshFailed}
            class="dot"
          ></span>{statusLabel}</span
        ><span
          class="observation-time"
          title={snapshot
            ? timestamp(snapshot.observedAt)
            : "No current observation"}
          >{snapshot
            ? `Observed ${new Date(snapshot.observedAt).toISOString().slice(11, 19)} UTC`
            : "Waiting for June"}</span
        ><label class="auto-refresh"
          ><input type="checkbox" bind:checked={autoRefresh} />Auto-refresh ·
          15s</label
        >
      </div>
      {#if refreshFailed}<div class="notice warning" role="alert">
          <CircleAlert size={17} />
          <div>
            <strong>Refresh failed. These observations may be stale.</strong>
            <p>
              Check your connection and refresh again. The timestamp shows the
              last successful observation.
            </p>
          </div>
        </div>{/if}

      {#if !snapshot || snapshot.status === "unavailable"}
        <section class="empty-state">
          <div class="empty-icon warning">
            <CircleAlert size={30} strokeWidth={1.3} />
          </div>
          <h2>{snapshot ? "Inventory is unavailable" : "Cannot reach June"}</h2>
          <p>
            {snapshot
              ? "June is responding, but BoxLite could not return its inventory."
              : "The dashboard is running, but no ready June process is responding."}
            This is not an empty inventory.
          </p>
          <Button variant="outline" onclick={refresh} disabled={refreshing}
            ><RefreshCw size={14} />Try again</Button
          ><span class="empty-footnote"
            >Read-only retries. No sandbox lifecycle actions.</span
          >
        </section>
      {:else if view === "runtime"}
        <section class="runtime-section">
          <div class="section-heading">
            <Server size={18} />
            <h2>BoxLite runtime</h2>
            <Badge variant="outline">{snapshot.status}</Badge>
          </div>
          <dl class="facts">
            <div>
              <dt>Provider</dt>
              <dd>BoxLite · embedded in June</dd>
            </div>
            <div>
              <dt>June revision</dt>
              <dd class="mono">{snapshot.revision ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Observation</dt>
              <dd>{timestamp(snapshot.observedAt)}</dd>
            </div>
            <div>
              <dt>Active worker limit</dt>
              <dd>{snapshot.limits.active} leases</dd>
            </div>
            <div>
              <dt>Retained sandbox limit</dt>
              <dd>{snapshot.limits.retained} environments</dd>
            </div>
            <div>
              <dt>Command timeout</dt>
              <dd>{snapshot.limits.commandSeconds} seconds</dd>
            </div>
            <div>
              <dt>Output limit</dt>
              <dd>
                {snapshot.limits.outputBytes.toLocaleString("en-US")} bytes per command
              </dd>
            </div>
          </dl>
        </section>
        <section class="runtime-section">
          <div class="section-heading">
            <ShieldCheck size={18} />
            <h2>What this dashboard observes</h2>
          </div>
          <div class="explanation-grid">
            <div>
              <h3>Metadata, not measured usage</h3>
              <p>
                CPU and memory values describe allocated capacity. Reads do not
                collect VM metrics or wake stopped compute.
              </p>
            </div>
            <div>
              <h3>Retained disks are separate</h3>
              <p>
                A stopped sandbox may still have a disk. A disabled provider
                does not prove retained disks are absent.
              </p>
            </div>
            <div>
              <h3>Worker-owned lifecycle</h3>
              <p>
                June owns creation, execution and cleanup. This dashboard cannot
                run commands, read files or change a sandbox.
              </p>
            </div>
            <div>
              <h3>Bounded, private activity</h3>
              <p>
                Up to 200 metadata-only events from this process. No command
                text, output, credentials or conversation content.
              </p>
            </div>
          </div>
        </section>
      {:else if snapshot.status === "disabled"}
        <section class="empty-state">
          <div class="empty-icon"><Box size={34} strokeWidth={1.2} /></div>
          <h2>BoxLite isn’t enabled yet</h2>
          <p>
            June is connected. Her sandbox provider is not active in this
            process, so inventory and activity are not available.
          </p>
          <Button href="/?view=runtime" variant="outline"
            >View runtime<ArrowUpRight size={14} /></Button
          ><span class="empty-footnote"
            >Enabling BoxLite requires an operator-configured KVM host.</span
          >
        </section>
        <div class="bottom-explainer">
          <div>
            <Cpu size={17} />
            <div>
              <strong>Isolated compute</strong>
              <p>Worker-owned environments with bounded execution.</p>
            </div>
          </div>
          <div>
            <HardDrive size={17} />
            <div>
              <strong>Persistent workspace</strong>
              <p>Disks can outlive a worker’s active compute.</p>
            </div>
          </div>
          <div>
            <ShieldCheck size={17} />
            <div>
              <strong>Safe to inspect</strong>
              <p>Viewing never starts, stops or deletes a VM.</p>
            </div>
          </div>
        </div>
      {:else if selectedId}
        {#if box}
          <div class="detail-title">
            <Box size={22} /><code>{box.id}</code><Badge
              variant="outline"
              class={box.running ? "state-running" : ""}
              ><span class:good={box.running} class="dot"
              ></span>{box.state}</Badge
            >
          </div>
          <Tabs.Root value="overview"
            ><Tabs.List variant="line" class="detail-tabs"
              ><Tabs.Trigger value="overview">Overview</Tabs.Trigger
              ><Tabs.Trigger value="activity">Worker activity</Tabs.Trigger
              ></Tabs.List
            ><Tabs.Content value="overview"
              ><div class="allocation-strip">
                <div>
                  <Cpu size={17} /><strong>{box.cpus}</strong><span
                    >vCPU allocated</span
                  >
                </div>
                <div>
                  <Server size={17} /><strong
                    >{(box.memoryMib / 1024).toLocaleString("en-US")}</strong
                  ><span>GiB allocated</span>
                </div>
                <div>
                  <HardDrive size={17} /><strong>Retained</strong><span
                    >workspace policy</span
                  >
                </div>
              </div>
              <dl class="facts">
                <div>
                  <dt>Sandbox ID</dt>
                  <dd class="mono">{box.id}</dd>
                </div>
                <div>
                  <dt>Worker fingerprint</dt>
                  <dd class="mono">{box.worker}</dd>
                </div>
                <div>
                  <dt>Lease state</dt>
                  <dd>
                    {lease?.state.replaceAll("_", " ") ?? "No current lease"}
                  </dd>
                </div>
                <div>
                  <dt>Image</dt>
                  <dd class="mono">{box.image}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{timestamp(box.createdAt)}</dd>
                </div>
                <div>
                  <dt>Last started</dt>
                  <dd>{timestamp(box.startedAt)}</dd>
                </div>
                <div>
                  <dt>Outbound network</dt>
                  <dd>
                    {box.outbound}{box.outbound === "enabled"
                      ? " · restricted by host policy"
                      : ""}
                  </dd>
                </div>
              </dl>
              <p class="section-note">
                Allocations are not measured usage. SDK state is an observation,
                not proof of teardown.
              </p></Tabs.Content
            ><Tabs.Content value="activity"
              ><ActivityList
                entries={snapshot.activity.filter(
                  (entry) => entry.worker === box.worker,
                )}
                since={snapshot.activitySince}
              />
              <p class="section-note">
                Events belong to the worker fingerprint and can include previous
                sandbox policy generations.
              </p></Tabs.Content
            ></Tabs.Root
          >
        {:else}<section class="empty-state">
            <Box size={30} />
            <h2>Sandbox not in this observation</h2>
            <p>
              It may have been removed or no longer appears in June’s inventory.
            </p>
            <Button href="/" variant="outline">Return to sandboxes</Button>
          </section>{/if}
      {:else if view === "activity"}
        <ActivityList
          entries={snapshot.activity}
          since={snapshot.activitySince}
        />
      {:else}
        <div class="inventory-summary">
          <span><strong>{snapshot.boxes.length}</strong> retained</span><span
            ><span class="dot good"></span><strong
              >{snapshot.boxes.filter((entry) => entry.running).length}</strong
            > running</span
          ><span
            ><strong>{snapshot.leases.length} / {snapshot.limits.active}</strong
            > worker leases</span
          >
        </div>
        {#if snapshot.leases.some((entry) => entry.state === "needs_review")}<div
            class="notice warning"
          >
            <CircleAlert size={17} />
            <div>
              <strong>Cleanup needs review</strong>
              <p>
                A worker lease has an uncertain cleanup result. This dashboard
                does not retry it.
              </p>
            </div>
          </div>{/if}
        <div class="inventory-toolbar">
          <div class="search-field">
            <Search size={15} /><Input
              aria-label="Search sandboxes"
              placeholder="Search ID, worker or image…"
              bind:value={search}
              class="h-9 rounded-md pl-9"
            />
          </div>
          <select aria-label="Filter by compute state" bind:value={filter}
            ><option value="all">All states</option><option value="running"
              >Running</option
            ><option value="stopped">Not running</option></select
          ><span class="result-count"
            >{filtered.length}
            {filtered.length === 1 ? "sandbox" : "sandboxes"}</span
          >
        </div>
        {#if filtered.length}
          <div class="table-scroll">
            <table>
              <thead
                ><tr
                  ><th>Sandbox</th><th>State</th><th>Image</th><th
                    >Allocation</th
                  ><th>Created (UTC)</th><th
                    ><span class="sr-only">Details</span></th
                  ></tr
                ></thead
              ><tbody
                >{#each filtered as entry (entry.id)}<tr
                    ><td
                      ><a
                        class="sandbox-link mono"
                        href={`/?sandbox=${encodeURIComponent(entry.id)}`}
                        ><Box size={15} />{entry.id}</a
                      ><span class="worker-id mono"
                        >worker {entry.worker.slice(0, 12)}</span
                      ></td
                    ><td
                      ><span class="table-state"
                        ><span class:good={entry.running} class="dot"
                        ></span>{entry.state}</span
                      ></td
                    ><td
                      ><span class="image-name mono" title={entry.image}
                        >{entry.image}</span
                      ></td
                    ><td class="allocation-cell mono"
                      >{entry.cpus} vCPU<span
                        >{(entry.memoryMib / 1024).toLocaleString("en-US")} GiB</span
                      ></td
                    ><td class="muted nowrap"
                      >{new Date(entry.createdAt)
                        .toISOString()
                        .slice(0, 16)
                        .replace("T", " ")}</td
                    ><td
                      ><a
                        class="row-arrow"
                        href={`/?sandbox=${encodeURIComponent(entry.id)}`}
                        aria-label={`Inspect ${entry.id}`}
                        ><ChevronRight size={16} /></a
                      ></td
                    ></tr
                  >{/each}</tbody
              >
            </table>
          </div>
        {:else}<div class="quiet-empty">
            <Boxes size={30} strokeWidth={1.25} />
            <h3>
              {snapshot.boxes.length
                ? "No matching sandboxes"
                : "No retained sandboxes"}
            </h3>
            <p>
              {snapshot.boxes.length
                ? "Try a different ID, worker or image, or clear your filters."
                : "Environments appear here when June creates them for an authorized worker."}
            </p>
            {#if search || filter !== "all"}<Button
                variant="outline"
                onclick={() => {
                  search = "";
                  filter = "all";
                }}>Clear filters</Button
              >{/if}
          </div>{/if}
        <p class="table-footer">
          June-owned environments only<span
            >Allocated capacity · not measured usage</span
          >
        </p>
      {/if}
    </main>
    <footer class="page-footer">
      <span><Box size={13} />Powered by BoxLite</span><span
        >Private infrastructure. Clear visibility.</span
      >
    </footer>
  </div>
</div>
