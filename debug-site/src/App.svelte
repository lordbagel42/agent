<script lang="ts">
  import {
    Bot,
    CircleDot,
    Files,
    Fingerprint,
    Info,
    LayoutDashboard,
    LockKeyhole,
    LogOut,
    RefreshCw,
    Rocket,
    TriangleAlert,
  } from "@lucide/svelte";
  import { onMount, tick } from "svelte";
  import { createArchive } from "$lib/archive.js";
  import CaptureView from "$lib/components/CaptureView.svelte";
  import CapturesView from "$lib/components/CapturesView.svelte";
  import IssuesView from "$lib/components/IssuesView.svelte";
  import Loading from "$lib/components/Loading.svelte";
  import Login from "$lib/components/Login.svelte";
  import OperationsView from "$lib/components/OperationsView.svelte";
  import OverviewView from "$lib/components/OverviewView.svelte";
  import Passkeys from "$lib/components/Passkeys.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { link } from "$lib/display.js";
  import {
    type OperationRoute,
    type OperationScope,
    operationRoute,
    parseRoute,
    type Route,
    routeHref,
  } from "$lib/route.js";

  const archive = createArchive();
  const current = () => parseRoute(location.pathname, location.search);
  let route = $state<Route>(current());
  let passkeysOpen = $state(false);
  let zone = $state("local");
  let main: HTMLElement | undefined = $state();
  /** Last list state per workspace, so the header returns to it. */
  let remembered = $state<Partial<Record<OperationScope, OperationRoute>>>({});
  const overviewSections = [
    "captures",
    "failures",
    "deployments",
    "amp",
  ] as const;
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utc = $derived(zone === "utc");
  const capturesRoute = $derived<Route>({
    view: "captures",
    query: $archive.query,
    offset: $archive.offset,
  });
  const busy = $derived(
    $archive.indexBusy ||
      $archive.captureBusy ||
      $archive.operations.indexBusy ||
      $archive.operations.detailBusy ||
      $archive.captureLinks.busy ||
      $archive.issuesBusy ||
      overviewSections.some((name) => $archive.overview[name].busy),
  );
  const sections = $derived([
    {
      label: "Overview",
      icon: LayoutDashboard,
      route: { view: "overview" } as Route,
      active: route.view === "overview",
    },
    {
      label: "Captures",
      icon: Files,
      route: capturesRoute,
      active: route.view === "captures" || route.view === "capture",
    },
    {
      label: "Issues",
      icon: CircleDot,
      route: { view: "issues" } as Route,
      active: route.view === "issues",
    },
    ...(
      [
        ["Deployments", Rocket, "deployments"],
        ["Errors", TriangleAlert, "errors"],
        ["Amp", Bot, "amp"],
      ] as const
    ).map(([label, icon, scope]) => ({
      label,
      icon,
      route: remembered[scope] ?? operationRoute(scope),
      active: route.view === "operations" && route.scope === scope,
    })),
  ]);
  $effect(() => {
    if ($archive.phase !== "ready") {
      passkeysOpen = false;
      remembered = {};
    } else if (route.view === "operations") remembered[route.scope] = route;
  });

  async function navigate(next: Route) {
    if ($archive.phase !== "ready") {
      location.assign(routeHref(next));
      return;
    }
    const href = routeHref(next);
    const viewChanged =
      next.view !== route.view ||
      (next.view === "operations" &&
        route.view === "operations" &&
        next.scope !== route.scope);
    if (href !== location.pathname + location.search)
      history.pushState(null, "", href);
    route = next;
    passkeysOpen = false;
    void archive.open(next);
    if (viewChanged) {
      await tick();
      main?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
  }
  function refresh() {
    void archive.open(route, true);
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
    void archive.start(route);
    const pop = () => {
      passkeysOpen = false;
      route = current();
      if ($archive.phase === "ready") void archive.open(route);
    };
    // A restored browser history document must re-check its private session.
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) {
        route = current();
        void archive.start(route);
      }
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

<a class="skip-link" href="#debug-main">Skip to content</a>
<header class="app-header">
  <a class="brand" {...link({ view: "overview" }, navigate)}
    ><span>June</span><span class="brand-divider" aria-hidden="true">/</span
    ><span>Debug</span></a
  >
  {#if $archive.phase === "ready"}
    <nav class="app-nav" aria-label="Debug workspaces">
      {#each sections as section (section.label)}
        <a
          {...link(section.route, navigate)}
          aria-current={section.active && !passkeysOpen ? "page" : undefined}
          ><section.icon size={14} aria-hidden="true" />{section.label}</a
        >
      {/each}
    </nav>
  {/if}
  <div class="header-actions">
    <span
      class="private-indicator"
      class:authenticated={$archive.phase === "ready"}
      ><LockKeyhole size={13} aria-hidden="true" />Private archive</span
    >{#if $archive.phase === "ready"}<Button
        variant="ghost"
        size="sm"
        aria-pressed={passkeysOpen}
        onclick={() => {
          passkeysOpen = !passkeysOpen;
          if (passkeysOpen) void archive.loadPasskeys();
        }}><Fingerprint size={14} aria-hidden="true" />Passkeys</Button
      ><Button
        variant="ghost"
        size="sm"
        onclick={() => {
          passkeysOpen = false;
          void archive.logout();
        }}><LogOut size={14} aria-hidden="true" />Sign out</Button
      >{/if}
  </div>
</header>

{#if $archive.phase === "checking"}
  <main id="debug-main" tabindex="-1">
    <Loading label="Checking your private session…" />
  </main>
{:else if $archive.phase === "login"}
  <main id="debug-main" tabindex="-1">
    <Login
      busy={$archive.loginBusy}
      error={$archive.loginError}
      notice={$archive.notice}
      signoutError={$archive.actionError}
      onlogin={(token) => archive.login(token, current())}
      onpasskey={() => archive.loginWithPasskey(current())}
      onlogout={() => archive.logout()}
    />
  </main>
{:else if $archive.phase === "error"}
  <main id="debug-main" tabindex="-1" class="empty-state">
    <h1>Archive connection unavailable</h1>
    <p>
      Your session could not be checked. No private archive data has been
      loaded.
    </p>
    <Button variant="outline" onclick={() => archive.start(current())}
      >Retry connection</Button
    >
  </main>
{:else if passkeysOpen}
  <main id="debug-main" tabindex="-1">
    <Passkeys
      state={$archive}
      onadd={archive.addPasskey}
      onremove={archive.removePasskey}
      onrefresh={archive.loadPasskeys}
      onback={() => (passkeysOpen = false)}
    />
  </main>
{:else}
  <div class="context-bar">
    <p>
      <Info size={13} aria-hidden="true" />Archived observations, not live
      health. Reading never contacts June or repeats an operation.
    </p>
    <div class="context-actions">
      <label class="timezone-control"
        >Times<select aria-label="Timestamp timezone" bind:value={zone}
          ><option value="local">Local · {localZone}</option><option value="utc"
            >UTC</option
          ></select
        ></label
      ><Button variant="outline" size="sm" onclick={refresh} disabled={busy}
        ><RefreshCw size={13} aria-hidden="true" />{busy
          ? "Reading…"
          : "Refresh"}</Button
      >
    </div>
  </div>
  <main id="debug-main" tabindex="-1" class="workspace" bind:this={main}>
    {#if route.view === "overview"}
      <OverviewView
        overview={$archive.overview}
        {utc}
        onnavigate={navigate}
        onretry={archive.retryOverview}
      />
    {:else if route.view === "captures"}
      <CapturesView
        {route}
        state={$archive}
        {utc}
        onnavigate={navigate}
        onretry={() => archive.open(route, true)}
      />
    {:else if route.view === "issues"}
      <IssuesView
        state={$archive}
        {utc}
        onrefresh={() => archive.loadIssues()}
        onnavigate={navigate}
      />
    {:else if route.view === "capture"}
      {#if $archive.captureBusy && !$archive.snapshot}<Loading />
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
          <div class="inline-actions">
            <Button variant="outline" onclick={() => archive.open(route, true)}
              >Retry capture</Button
            >
            <Button variant="ghost" {...link(capturesRoute, navigate)}
              >Browse captures</Button
            >
          </div>
        </div>
      {:else if $archive.snapshot}
        <IssuesView
          state={$archive}
          {utc}
          compact
          onrefresh={() => archive.loadIssues(`debug:${$archive.snapshot?.id}`)}
          onnavigate={navigate}
        />
        {#key $archive.snapshot.id}<CaptureView
            snapshot={$archive.snapshot}
            {utc}
            page={route.page}
            links={$archive.captureLinks}
            back={capturesRoute}
            downloading={$archive.downloadBusy}
            actionError={$archive.actionError}
            ondownload={download}
            onnavigate={navigate}
            onretrylinks={() => {
              if ($archive.snapshot)
                void archive.retryCaptureLinks($archive.snapshot.id);
            }}
          />{/key}
      {/if}
    {:else}
      <OperationsView
        {route}
        state={$archive.operations}
        {utc}
        onnavigate={navigate}
        onevents={(offset) =>
          archive.selectOperation($archive.operations.selectedId, offset)}
        onretrylist={() => archive.searchOperations($archive.operations)}
        onretrydetail={() =>
          archive.selectOperation(
            $archive.operations.selectedId,
            $archive.operations.eventOffset,
          )}
      />
    {/if}
  </main>
{/if}
