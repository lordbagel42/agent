<script lang="ts">
  import {
    ArrowUpRight,
    ChevronLeft,
    ChevronRight,
    RotateCw,
  } from "@lucide/svelte";
  import type { OperationsState } from "$lib/archive.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    ampSources,
    link,
    outcomeLabel,
    sourceLabel,
    statusLabel,
    threadHref,
  } from "$lib/display.js";
  import {
    type OperationRoute,
    operationRoute,
    type Route,
  } from "$lib/route.js";
  import type { OperationEvent } from "$lib/types.js";
  import ControllerFacts from "./ControllerFacts.svelte";
  import Loading from "./Loading.svelte";
  import Revision from "./Revision.svelte";
  import StateBadge from "./StateBadge.svelte";
  import Time from "./Time.svelte";

  let {
    route,
    state: operations,
    utc,
    onnavigate,
    onevents,
    onretry,
    onsignature,
  }: {
    route: OperationRoute;
    state: OperationsState;
    utc: boolean;
    onnavigate: (route: Route) => void;
    onevents: (offset: number) => void;
    onretry: () => void;
    onsignature: (failureKey: string) => void;
  } = $props();
  const detail = $derived(
    operations.detail?.operation.latest.operationId === route.id
      ? operations.detail
      : null,
  );
  const nav = (next: Route) => link(next, onnavigate);
  const toOperation = (id: string) =>
    operationRoute(route.scope, { ...route, id });
  const unique = (values: (string | null | undefined)[]) => [
    ...new Set(values.filter((value): value is string => !!value)),
  ];
  /** Associations recorded on this page of the operation's own events. */
  const recorded = $derived(
    detail
      ? {
          threads: unique(detail.events.map((event) => event.threadId)),
          captures: unique(detail.events.map((event) => event.snapshotId)),
          related: unique(
            detail.events.map((event) => event.relatedOperationId),
          ).filter((id) => id !== route.id),
        }
      : null,
  );
  const listed = $derived(
    !operations.index ||
      operations.index.items.some(
        (item) => item.latest.operationId === route.id,
      ),
  );
  function reveal(event: OperationEvent) {
    const row = document.getElementById(`event-${event.id}`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "center" });
  }
</script>

{#snippet what(event: OperationEvent)}
  <code>{event.phase ?? event.controller?.phase ?? "phase unknown"}</code
  >{#if event.reason}
    · <code>{event.reason}</code>{/if}
{/snippet}

{#snippet threadLink(id: string)}
  <a
    class="mono thread-link"
    href={threadHref(id)}
    target="_blank"
    rel="noreferrer"
    title={id}>{id.slice(0, 10)}<ArrowUpRight size={12} aria-hidden="true" /></a
  >
{/snippet}

{#snippet captureLink(id: string)}
  <a class="mono" title={id} {...nav({ view: "capture", id, page: "evidence" })}
    >{id.slice(0, 8)}</a
  >
{/snippet}

{#snippet eventFacts(event: OperationEvent)}
  <dl class="fact-grid compact">
    <div>
      <dt>Event ID</dt>
      <dd class="mono">{event.id}</dd>
    </div>
    <div>
      <dt>Failure marker</dt>
      <dd>{event.failure ? "Recorded" : "None"}</dd>
    </div>
    <div>
      <dt>Revision</dt>
      <dd><Revision value={event.revision} /></dd>
    </div>
    <div>
      <dt>Attempt</dt>
      <dd>{event.attempt ?? "Not recorded"}</dd>
    </div>
    <div>
      <dt>Recorded retry time</dt>
      <dd>
        {#if event.retryAt !== undefined}<Time
            value={event.retryAt}
            {utc}
          />{:else}<span class="muted">Not recorded</span>{/if}
      </dd>
    </div>
    <div>
      <dt>Amp thread</dt>
      <dd>
        {#if event.threadId}{@render threadLink(event.threadId)}{:else}<span
            class="muted">Not recorded</span
          >{/if}
      </dd>
    </div>
    <div>
      <dt>Capture</dt>
      <dd>
        {#if event.snapshotId}{@render captureLink(
            event.snapshotId,
          )}{:else}<span class="muted">Not recorded</span>{/if}
      </dd>
    </div>
    <div>
      <dt>Related operation</dt>
      <dd>
        {#if event.relatedOperationId}<a
            class="mono"
            {...nav(toOperation(event.relatedOperationId))}
            >{event.relatedOperationId}</a
          >{:else}<span class="muted">Not recorded</span>{/if}
      </dd>
    </div>
    {#if event.controller}
      {@const c = event.controller}
      <div>
        <dt>Active / observed</dt>
        <dd>
          <Revision value={c.activeRevision} /> /
          <Revision value={c.observedRevision} />
        </dd>
      </div>
      <div>
        <dt>Target / controller</dt>
        <dd>
          <Revision value={c.targetRevision} /> /
          <Revision value={c.controllerRevision} />
        </dd>
      </div>
      <div>
        <dt>Blocked / hold</dt>
        <dd>
          {c.blocked ? "Blocked" : "Not blocked"} · {c.operatorHold
            ? "hold recorded"
            : "no hold"}
        </dd>
      </div>
      <div>
        <dt>Retries / queue</dt>
        <dd>
          {c.retryAttempts ?? "?"} attempts · {c.queuedRevisions.length} queued{c.omittedQueueCount
            ? `, ${c.omittedQueueCount} omitted`
            : ""}
        </dd>
      </div>
    {/if}
  </dl>
{/snippet}

{#if route.id === null}
  <div class="detail-empty">
    <h2>Select an operation</h2>
    <p>
      Its recorded states, exact failure event, same-signature history and
      immutable timeline open here. Queued and unknown attempts stay visible
      even without an Amp thread.
    </p>
  </div>
{:else if operations.detailBusy}<Loading label="Reading operation timeline…" />
{:else if operations.detailError}<div class="detail-empty" role="alert">
    <h2>
      {operations.detailError === "missing"
        ? "Operation not in the archive"
        : "Operation could not be read"}
    </h2>
    <p>
      {operations.detailError === "missing"
        ? "This ID is not in the retained archive. Publication may still be pending, or this archive may not contain it."
        : "The archive could not return this timeline. Retrying only re-reads it; the operation is not repeated."}
    </p>
    <Button variant="outline" size="sm" onclick={onretry}
      ><RotateCw size={13} aria-hidden="true" />Retry read</Button
    >
  </div>
{:else if detail && recorded}
  {@const operation = detail.operation}
  {@const latest = operation.latest}
  <header class="detail-head">
    <div class="detail-title">
      <h2>{sourceLabel[latest.source]}</h2>
      <StateBadge event={latest} />
    </div>
    <p class="detail-id mono">{latest.operationId}</p>
    <p class="detail-outcome">
      {outcomeLabel(latest)}: <strong>{statusLabel(latest.status)}</strong> ·
      {@render what(latest)}
    </p>
    {#if ampSources.has(latest.source) && latest.status === "completed"}<p
        class="scope-note"
      >
        Completed means the execution ended. It does not verify a fix.
      </p>{/if}
    {#if !listed}<p class="panel-note">
        Not on the current results page. Filters and paging do not change this
        selection.
      </p>{/if}
  </header>

  <dl class="fact-grid">
    <div>
      <dt>First observed</dt>
      <dd><Time value={operation.firstObservedAt} {utc} /></dd>
    </div>
    <div>
      <dt>Last observed</dt>
      <dd><Time value={operation.lastObservedAt} {utc} /></dd>
    </div>
    <div>
      <dt>Latest event time</dt>
      <dd><Time value={latest.occurredAt} {utc} /></dd>
    </div>
    <div>
      <dt>Events</dt>
      <dd>{detail.totalEvents.toLocaleString()}</dd>
    </div>
    <div>
      <dt>Latest revision</dt>
      <dd><Revision value={latest.revision} /></dd>
    </div>
    <div>
      <dt>Amp threads recorded</dt>
      <dd class="link-list">
        {#each recorded.threads as id (id)}{@render threadLink(id)}{:else}<span
            class="muted">None on this timeline page</span
          >{/each}
      </dd>
    </div>
    <div>
      <dt>Captures recorded</dt>
      <dd class="link-list">
        {#each recorded.captures as id (id)}{@render captureLink(
            id,
          )}{:else}<span class="muted">None on this timeline page</span>{/each}
      </dd>
    </div>
    <div>
      <dt>Related operations recorded</dt>
      <dd class="link-list">
        {#each recorded.related as id (id)}<a
            class="mono"
            {...nav(toOperation(id))}>{id}</a
          >{:else}<span class="muted">None on this timeline page</span>{/each}
      </dd>
    </div>
  </dl>

  {#if latest.source === "controller"}
    <ControllerFacts
      controller={latest}
      loading={false}
      failed={false}
      {utc}
      {onnavigate}
      {onretry}
    />
  {/if}

  {#if operation.failure && operation.failureKey}
    {@const failure = operation.failure}
    <section class="detail-section" aria-labelledby="failure-heading">
      <header class="section-head">
        <h3 id="failure-heading">Latest recorded failure</h3>
        {#if detail.events.some((event) => event.id === failure.id)}<Button
            variant="ghost"
            size="sm"
            onclick={() => reveal(failure)}
            >Show event #{failure.sequence} in timeline</Button
          >{:else}<span class="panel-meta"
            >Event #{failure.sequence} · on another timeline page</span
          >{/if}
      </header>
      {#if failure.id !== latest.id}<p class="panel-note">
          Historical failure. The latest recorded state is
          <strong>{statusLabel(latest.status)}</strong>; that does not verify
          the failure's cause was fixed.
        </p>{/if}
      <dl class="fact-grid">
        <div>
          <dt>Recorded state</dt>
          <dd><StateBadge event={failure} /></dd>
        </div>
        <div>
          <dt>Phase · reason</dt>
          <dd>{@render what(failure)}</dd>
        </div>
        <div>
          <dt>Failure observed</dt>
          <dd><Time value={failure.observedAt} {utc} /></dd>
        </div>
        <div>
          <dt>Event time</dt>
          <dd><Time value={failure.occurredAt} {utc} /></dd>
        </div>
      </dl>
      <div class="signature-line">
        <span
          >Signature <code>{operation.failureKey}</code> ·
          {operation.matchingFailures.toLocaleString()}
          {operation.matchingFailures === 1 ? "operation" : "operations"},
          including this one</span
        >
        <Button
          variant="outline"
          size="sm"
          onclick={() => onsignature(operation.failureKey ?? "")}
          >List all with this signature</Button
        >
      </div>
      <p class="panel-note">
        Same source, phase and reason (or status). Not proof of the same root
        cause.
      </p>
      {#if detail.related.length}
        <div class="table-wrap">
          <table class="data-table">
            <caption class="sr-only"
              >Other operations with this signature</caption
            >
            <thead
              ><tr
                ><th scope="col">Operation</th><th scope="col"
                  >Last recorded state</th
                ><th scope="col">Last observed</th><th
                  scope="col"
                  class="col-optional">Amp thread</th
                ></tr
              ></thead
            >
            <tbody>
              {#each detail.related as item (item.latest.operationId)}
                <tr>
                  <td
                    ><a
                      class="mono cell-id"
                      title={item.latest.operationId}
                      {...nav(toOperation(item.latest.operationId))}
                      >{item.latest.operationId}</a
                    ></td
                  >
                  <td><StateBadge event={item.latest} /></td>
                  <td><Time value={item.lastObservedAt} {utc} compact /></td>
                  <td class="col-optional"
                    >{#if item.latest.threadId}{@render threadLink(
                        item.latest.threadId,
                      )}{:else if item.failure?.threadId}{@render threadLink(
                        item.failure.threadId,
                      )}{:else}<a {...nav(toOperation(item.latest.operationId))}
                        >Check timeline</a
                      >{/if}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if operation.matchingFailures - 1 > detail.related.length}<p
            class="panel-note"
          >
            Showing the {detail.related.length} most recent of {operation.matchingFailures -
              1} other operations. List all to page through the rest.
          </p>{/if}
      {:else}<p class="panel-note">
          No other archived operation has this signature.
        </p>{/if}
    </section>
  {/if}

  <section class="detail-section" aria-labelledby="timeline-heading">
    <header class="section-head">
      <h3 id="timeline-heading">Immutable timeline</h3>
      <span class="panel-meta"
        >{detail.totalEvents.toLocaleString()}
        {detail.totalEvents === 1 ? "event" : "events"} · newest sequence first</span
      >
    </header>
    <p class="panel-note">
      Event time and observation time come from the source, not upload arrival.
      Unknown times are not reconstructed.
    </p>
    <ol class="timeline">
      {#each detail.events as event (event.id)}
        <li
          id={`event-${event.id}`}
          class:failure-row={event.failure}
          tabindex="-1"
        >
          <div class="timeline-row">
            <span class="mono timeline-seq">#{event.sequence}</span>
            <StateBadge {event} />
            <span class="timeline-what">{@render what(event)}</span>
            <span class="timeline-time"
              ><span class="muted">Event</span>
              <Time value={event.occurredAt} {utc} /></span
            >
            <span class="timeline-time"
              ><span class="muted">Observed</span>
              <Time value={event.observedAt} {utc} /></span
            >
          </div>
          <details class="fact-details">
            <summary
              >Metadata<span class="sr-only">
                for event {event.sequence}</span
              ></summary
            >
            {@render eventFacts(event)}
          </details>
        </li>
      {/each}
    </ol>
    <div class="list-foot">
      <span class="panel-meta"
        >{detail.events.length
          ? operations.eventOffset + 1
          : 0}–{operations.eventOffset + detail.events.length} of {detail.totalEvents.toLocaleString()}</span
      >
      <div class="inline-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={operations.eventOffset === 0}
          onclick={() => onevents(Math.max(0, operations.eventOffset - 100))}
          ><ChevronLeft size={14} />Newer events</Button
        ><Button
          variant="outline"
          size="sm"
          disabled={detail.nextOffset === null}
          onclick={() => onevents(detail.nextOffset ?? 0)}
          >Older events<ChevronRight size={14} /></Button
        >
      </div>
    </div>
  </section>
{/if}
