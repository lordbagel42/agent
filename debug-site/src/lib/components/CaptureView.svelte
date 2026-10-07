<script lang="ts">
  import {
    ArrowLeft,
    Download,
    FileJson,
    MessagesSquare,
    RotateCw,
  } from "@lucide/svelte";
  import type { CaptureLinks } from "$lib/archive.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import { link } from "$lib/display.js";
  import { projectSnapshot } from "$lib/projection.js";
  import { operationRoute, type Route } from "$lib/route.js";
  import type { DebugSnapshot } from "$lib/types.js";
  import ConversationView from "./ConversationView.svelte";
  import EvidenceTable from "./EvidenceTable.svelte";
  import JsonViewer from "./JsonViewer.svelte";
  import Revision from "./Revision.svelte";
  import StateBadge from "./StateBadge.svelte";
  import Time from "./Time.svelte";
  let {
    snapshot,
    utc,
    page,
    links,
    back,
    downloading,
    actionError,
    ondownload,
    onnavigate,
    onretrylinks,
  }: {
    snapshot: DebugSnapshot;
    utc: boolean;
    page: "evidence" | "conversation";
    links: CaptureLinks;
    back: Route;
    downloading: boolean;
    actionError: string;
    ondownload: () => void;
    onnavigate: (route: Route) => void;
    onretrylinks: () => void;
  } = $props();
  const view = $derived(projectSnapshot(snapshot));
  const nav = (route: Route) => link(route, onnavigate);
  const linked = $derived(links.id === snapshot.id ? links : null);
  const pages = ["evidence", "conversation"] as const;
  let tab = $state("timeline");
</script>

<div class="capture-bar">
  <a class="back-link" {...nav(back)}
    ><ArrowLeft size={14} aria-hidden="true" />Captures</a
  >
  <h1>
    <FileJson size={16} aria-hidden="true" />Capture
    <span class="mono" title={snapshot.id}>{snapshot.id}</span>
  </h1>
  <Badge variant="outline">Archived</Badge>
  <nav class="segmented" aria-label="Capture pages">
    {#each pages as destination (destination)}
      <a
        {...nav({ view: "capture", id: snapshot.id, page: destination })}
        aria-current={page === destination ? "page" : undefined}
      >
        {#if destination === "conversation"}<MessagesSquare
            size={14}
            aria-hidden="true"
          />Conversation
        {:else}<FileJson size={14} aria-hidden="true" />Evidence{/if}
      </a>
    {/each}
  </nav>
  <Button
    variant="outline"
    size="sm"
    onclick={ondownload}
    disabled={downloading}
    ><Download size={14} />{downloading ? "Exporting…" : "Export JSON"}</Button
  >
</div>
{#if actionError}<p class="action-error" role="alert">{actionError}</p>{/if}

<dl class="capture-facts">
  <div>
    <dt>Captured</dt>
    <dd><Time value={snapshot.capturedAt} {utc} /></dd>
  </div>
  <div>
    <dt>Mode</dt>
    <dd>
      {snapshot.snapshotOnly === true
        ? "DEBUG · storage only"
        : "DEBUGSHARE / historical"}
    </dd>
  </div>
  <div>
    <dt>Session</dt>
    <dd class="mono">{snapshot.sessionId}</dd>
  </div>
  <div>
    <dt>Code revision</dt>
    <dd>
      {#if snapshot.revision}<Revision value={snapshot.revision} />{:else}<span
          class="muted">Not retained</span
        >{/if}
    </dd>
  </div>
  <div>
    <dt>Reporter</dt>
    <dd>
      {snapshot.reporter
        ? `${snapshot.reporter.channel} · ${snapshot.reporter.isOwner ? "owner" : "non-owner"}`
        : "Not retained"}
    </dd>
  </div>
</dl>

<section class="reported-reason" aria-label="Reporter-provided reason">
  <span class="reason-label"
    >Reported reason <span>· reporter text, not a verified diagnosis</span
    ></span
  >
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus lets long reporter text scroll without a pointer.) -->
  <p tabindex="0" role="region" aria-label="Reported reason, scrollable text">
    {snapshot.reason || "No reason was provided with this capture."}
  </p>
</section>

<div class="capture-relations">
  <span class="relation-label">Recorded operations</span>
  {#if !linked || linked.busy}<span class="muted" role="status"
      >Checking operation metadata for this capture ID…</span
    >
  {:else if linked.error}<span class="muted" role="alert"
      >Operation metadata could not be read.</span
    ><Button variant="ghost" size="sm" onclick={onretrylinks}
      ><RotateCw size={13} aria-hidden="true" />Retry</Button
    >
  {:else if !linked.index?.items.length}<span class="muted"
      >No archived operation metadata contains this capture ID.</span
    >
  {:else}
    {#each linked.index.items as item (item.latest.operationId)}<a
        class="relation"
        {...nav(
          operationRoute(
            item.latest.source === "deployment" ||
              item.latest.source === "recovery"
              ? "deployments"
              : "amp",
            { id: item.latest.operationId },
          ),
        )}
        ><code>{item.latest.operationId}</code><StateBadge
          event={item.latest}
        /></a
      >{/each}
    {#if linked.index.total > linked.index.items.length}<span class="muted"
        >+{linked.index.total - linked.index.items.length} more</span
      >{/if}
  {/if}
</div>

{#if page === "conversation"}
  <ConversationView rows={view.messages} {utc} />
{:else}
  <Tabs.Root bind:value={tab} class="capture-tabs">
    <Tabs.List
      variant="line"
      class="capture-tab-list"
      aria-label="Capture evidence sections"
    >
      <Tabs.Trigger value="timeline"
        >Timeline <span class="tab-count">{view.timeline.length}</span
        ></Tabs.Trigger
      >
      <Tabs.Trigger value="messages"
        >Messages <span class="tab-count">{view.messages.length}</span
        ></Tabs.Trigger
      >
      <Tabs.Trigger value="logs"
        >Timing logs <span class="tab-count">{view.logs.length}</span
        ></Tabs.Trigger
      >
      <Tabs.Trigger value="request">Model request</Tabs.Trigger>
      <Tabs.Trigger value="deliveries"
        >Deliveries <span class="tab-count">{view.deliveries.length}</span
        ></Tabs.Trigger
      >
      <Tabs.Trigger value="raw">Raw data</Tabs.Trigger>
      <Tabs.Trigger value="scope">Capture scope</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Content value="timeline">
      <p class="section-note">
        Point-in-time evidence, not live status. Newest recorded timestamps
        first; untimed records follow in source order. Markers are not spans or
        proof of successful work.
      </p>
      <EvidenceTable rows={view.timeline} label="Timeline" {utc} />
    </Tabs.Content>
    <Tabs.Content value="messages">
      <p class="section-note">
        Retained history in source order. Coordinator and activity histories can
        overlap; matching text is not independent evidence.
      </p>
      <EvidenceTable rows={view.messages} label="Messages" {utc} />
    </Tabs.Content>
    <Tabs.Content value="logs">
      <p class="section-note">
        Exactly matched message observations from the producer’s live trace
        buffer at capture time. Elapsed milliseconds start at ingress; displayed
        times add that offset to received-at. These are not raw service logs or
        historical traces from previous processes. Full trace metadata and
        delivery timings are in Raw data.
      </p>
      <EvidenceTable rows={view.logs} label="Timing logs" {utc} />
    </Tabs.Content>
    <Tabs.Content value="request">
      {#if view.modelRequest !== undefined && view.modelRequest !== null}
        <div class="section-intro">
          <h2>Retained model request</h2>
          <p>
            The host request retained at capture time, not provider-internal
            wire state. It may not correspond to the selected turn. Historical
            requests, latency, token use and cost are not inferred.
          </p>
          <code>{view.modelRequestPath}</code>
        </div>
        <JsonViewer value={view.modelRequest} label="Model request JSON" />
      {:else}
        <div class="empty-state">
          <h2>No model request retained</h2>
          <p>
            The request may predate retention support, be unavailable, or have
            been excluded by the capture’s retention rules. This does not mean
            no model was called.
          </p>
          <Button variant="outline" onclick={() => (tab = "scope")}
            >Review capture scope</Button
          >
        </div>
      {/if}
    </Tabs.Content>
    <Tabs.Content value="deliveries">
      <p class="section-note">
        Transport receipts as recorded. “Settled” is a phase, not a successful
        send. Activity receipts may omit attempts and outcome timestamps.
      </p>
      <EvidenceTable rows={view.deliveries} label="Deliveries" {utc} />
    </Tabs.Content>
    <Tabs.Content value="raw">
      <div class="section-intro">
        <h2>Complete capture</h2>
        <p>
          All archived fields, including fields not projected into the tables.
          The viewer is paginated; search and Export JSON cover the entire
          capture.
        </p>
      </div>
      <JsonViewer value={snapshot} label="Complete capture JSON" />
    </Tabs.Content>
    <Tabs.Content value="scope">
      <div class="scope-content">
        <section>
          <h2>Retention scope</h2>
          <p>
            The capture declares the following scope. This is not a claim of
            complete session or service history.
          </p>
          {#if snapshot.scope.length}<ul class="scope-list">
              {#each snapshot.scope as part, index (index)}<li>
                  <code>{part}</code>
                </li>{/each}
            </ul>{:else}<p class="muted">No scope was declared.</p>{/if}
        </section>
        <section>
          <h2>Capture exclusions</h2>
          <p>
            Reported by the producer of this capture; redaction is not a
            guarantee of complete secret removal.
          </p>
          {#if snapshot.exclusions.length}<ul class="exclusions-list">
              {#each snapshot.exclusions as exclusion, index (index)}<li>
                  {exclusion}
                </li>{/each}
            </ul>{:else}<p class="muted">
              No exclusions were declared. This does not establish completeness.
            </p>{/if}
        </section>
        <section>
          <h2>Capture provenance</h2>
          <dl class="provenance-facts">
            <div>
              <dt>Capture ID</dt>
              <dd class="mono">{snapshot.id}</dd>
            </div>
            <div>
              <dt>Activity evidence</dt>
              <dd>
                {view.activityAvailable
                  ? "Retained separately from coordinator evidence"
                  : "Not available in this capture"}
              </dd>
            </div>
            <div>
              <dt>Activity captured</dt>
              <dd><Time value={view.activityCapturedAt} {utc} /></dd>
            </div>
            <div>
              <dt>Reporter</dt>
              <dd>
                {snapshot.reporter
                  ? `${snapshot.reporter.channel} · ${snapshot.reporter.senderId}`
                  : "Not retained"}
              </dd>
            </div>
            <div>
              <dt>Reporter account</dt>
              <dd class="mono">
                {snapshot.reporter?.accountId ?? "Not retained"}
              </dd>
            </div>
            <div>
              <dt>Reporter authority</dt>
              <dd>
                {snapshot.reporter
                  ? snapshot.reporter.isOwner
                    ? "Owner, verified at ingress"
                    : "Non-owner reporter"
                  : "Unknown; not inferred from scope or text"}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </Tabs.Content>
  </Tabs.Root>
{/if}

<style>
  .capture-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 14px 0 12px;
  }
  .capture-bar h1 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 1rem;
  }
  .capture-bar h1 :global(svg) {
    color: var(--muted-text);
  }
  .capture-bar h1 .mono {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted-text);
    font-size: 0.86rem;
    text-decoration: none;
    padding-right: 12px;
    border-right: 1px solid var(--line);
  }
  .back-link:hover {
    color: var(--foreground);
  }
  .segmented {
    display: inline-flex;
    margin-left: auto;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    overflow: hidden;
  }
  .segmented a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    min-height: 30px;
    font-size: 0.86rem;
    color: var(--muted-text);
    text-decoration: none;
  }
  .segmented a + a {
    border-left: 1px solid var(--line-strong);
  }
  .segmented a:hover {
    color: var(--foreground);
  }
  .segmented a[aria-current="page"] {
    color: var(--foreground);
    background: var(--raised);
  }
  .segmented a:focus-visible {
    outline-offset: -2px;
  }
  @media (max-width: 800px) {
    .segmented {
      margin-left: 0;
      order: 5;
      flex: 1 1 100%;
    }
    .segmented a {
      flex: 1;
      justify-content: center;
      min-height: 44px;
    }
    .back-link {
      min-height: 44px;
    }
  }
</style>
