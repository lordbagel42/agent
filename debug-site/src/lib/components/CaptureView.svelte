<script lang="ts">
  import { Download, FileJson, Info, MessagesSquare } from "@lucide/svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import { projectSnapshot } from "$lib/projection.js";
  import type { DebugSnapshot } from "$lib/types.js";
  import ConversationView from "./ConversationView.svelte";
  import EvidenceTable from "./EvidenceTable.svelte";
  import JsonViewer from "./JsonViewer.svelte";
  import Time from "./Time.svelte";
  let {
    snapshot,
    utc,
    page,
    downloading,
    actionError,
    ondownload,
    onpage,
  }: {
    snapshot: DebugSnapshot;
    utc: boolean;
    page: "evidence" | "conversation";
    downloading: boolean;
    actionError: string;
    ondownload: () => void;
    onpage: (page: "evidence" | "conversation") => void;
  } = $props();
  const view = $derived(projectSnapshot(snapshot));
  let tab = $state("timeline");
</script>

<div class="capture-heading">
  <div class="capture-title">
    <FileJson size={19} aria-hidden="true" />
    <h1>Capture <span class="mono">{snapshot.id.slice(0, 8)}</span></h1>
    <Badge variant="outline">Archived</Badge>
  </div>
  <Button variant="outline" onclick={ondownload} disabled={downloading}
    ><Download size={15} />{downloading ? "Exporting…" : "Export JSON"}</Button
  >
</div>
{#if actionError}<p class="action-error" role="alert">{actionError}</p>{/if}
<nav class="capture-pages" aria-label="Capture pages">
  {#each ["evidence", "conversation"] as destination}
    <a
      href={`/s/${encodeURIComponent(snapshot.id)}${destination === "conversation" ? "/conversation" : ""}`}
      aria-current={page === destination ? "page" : undefined}
      onclick={(event) => {
        if (
          event.button ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onpage(destination === "conversation" ? "conversation" : "evidence");
      }}
    >
      {#if destination === "conversation"}<MessagesSquare
          size={15}
          aria-hidden="true"
        />Conversation
      {:else}<FileJson size={15} aria-hidden="true" />Evidence{/if}
    </a>
  {/each}
</nav>
{#if page === "conversation"}
  <ConversationView rows={view.messages} {utc} />
{:else}
  <section class="reported-reason" aria-label="Reporter-provided reason">
    <div class="reason-label">
      Reported reason <span>Reporter text, not a verified diagnosis</span>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus lets long reporter text scroll without a pointer.) -->
    <p tabindex="0" role="region" aria-label="Reported reason, scrollable text">
      {snapshot.reason || "No reason was provided with this capture."}
    </p>
  </section>
  <dl class="capture-facts">
    <div>
      <dt>Captured</dt>
      <dd><Time value={snapshot.capturedAt} {utc} /></dd>
    </div>
    <div>
      <dt>Session</dt>
      <dd class="mono">{snapshot.sessionId}</dd>
    </div>
    <div>
      <dt>Code revision</dt>
      <dd class="mono">{snapshot.revision || "Not retained"}</dd>
    </div>
    <div>
      <dt>Capture mode</dt>
      <dd>
        {snapshot.snapshotOnly === true
          ? "DEBUG · storage only"
          : "DEBUGSHARE / historical"}
      </dd>
    </div>
  </dl>
  <div class="capture-notice">
    <Info size={14} aria-hidden="true" />
    <p>
      Point-in-time evidence, not live status. This archive does not establish
      investigation or delivery success.
    </p>
  </div>

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
        Newest recorded timestamps first; untimed records follow in source
        order. Markers are not spans or proof of successful work.
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
  .capture-pages {
    display: flex;
    gap: 24px;
    border-bottom: 1px solid var(--line-strong);
  }
  .capture-pages a {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    color: var(--muted-text);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .capture-pages a:hover,
  .capture-pages a[aria-current="page"] {
    color: var(--foreground);
  }
  .capture-pages a[aria-current="page"] {
    border-bottom-color: var(--foreground);
  }
</style>
