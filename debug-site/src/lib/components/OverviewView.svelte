<script lang="ts">
  import { ArrowRight, RotateCw } from "@lucide/svelte";
  import type { OverviewState, Section } from "$lib/archive.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    kilobytes,
    link,
    sourceLabel,
    statusLabel,
    threadHref,
  } from "$lib/display.js";
  import { timestamp } from "$lib/projection.js";
  import { operationRoute, type Route } from "$lib/route.js";
  import Revision from "./Revision.svelte";
  import StateBadge from "./StateBadge.svelte";
  import Time from "./Time.svelte";
  import ControllerFacts from "./ControllerFacts.svelte";

  type Name = Exclude<keyof OverviewState, "controller">;
  let {
    overview,
    utc,
    onnavigate,
    onretry,
  }: {
    overview: OverviewState;
    utc: boolean;
    onnavigate: (route: Route) => void;
    onretry: (name: Name) => void;
  } = $props();
  const nav = (route: Route) => link(route, onnavigate);
  const names: Name[] = ["captures", "failures", "deployments", "amp"];
  const complete = $derived(
    names.every((name) => overview[name].data !== null),
  );
  const operationReads = $derived([
    overview.failures,
    overview.deployments,
    overview.amp,
  ]);
  /** Sections may have been read or retried at different times. */
  const latest = $derived.by(() => {
    const candidates: { at: number; label: string; route: Route }[] = [];
    const capture = overview.captures.data?.items[0];
    const capturedAt = capture ? timestamp(capture.capturedAt) : null;
    if (capture && capturedAt !== null)
      candidates.push({
        at: capturedAt,
        label: `Capture ${capture.id.slice(0, 8)}`,
        route: { view: "capture", id: capture.id, page: "evidence" },
      });
    for (const name of ["failures", "deployments", "amp"] as const) {
      const item = overview[name].data?.items[0];
      if (item)
        candidates.push({
          at: item.lastObservedAt,
          label: item.latest.operationId,
          route: operationRoute(name === "failures" ? "errors" : name, {
            id: item.latest.operationId,
          }),
        });
    }
    if (overview.controller)
      candidates.push({
        at: overview.controller.observedAt,
        label: "Controller observation",
        route: operationRoute("deployments", {
          id: overview.controller.operationId,
        }),
      });
    return candidates.sort((a, b) => b.at - a.at)[0] ?? null;
  });
</script>

{#snippet total(read: Section<{ total: number }>, route: Route, noun: string)}
  <dd>
    {#if read.data}<a {...nav(route)}
        ><strong>{read.data.total.toLocaleString()}</strong> {noun}</a
      >{:else if read.busy}<span class="muted">Reading…</span>{:else}<span
        class="muted">Unavailable</span
      >{/if}
  </dd>
{/snippet}

{#snippet sectionState(
  name: Name,
  read: Section<{ items: unknown[] }>,
  label: string,
  empty: string,
)}
  {#if read.busy}<p class="panel-note" role="status">Reading {label}…</p>
  {:else if read.error}<div class="panel-note" role="alert">
      <p>{label[0]?.toUpperCase()}{label.slice(1)} could not be read.</p>
      <Button variant="outline" size="sm" onclick={() => onretry(name)}
        ><RotateCw size={13} aria-hidden="true" />Retry</Button
      >
    </div>
  {:else if read.data && !read.data.items.length}<p class="panel-note">
      {empty}
    </p>{/if}
{/snippet}

<div class="page-head">
  <div>
    <h1>Overview</h1>
    <p>
      What the private archive last recorded. Archived observations, not live
      service health.
    </p>
  </div>
</div>

<dl class="summary-row" aria-label="Archive totals">
  <div class="summary-latest">
    <dt>Latest archived record</dt>
    <dd>
      {#if latest}<Time value={latest.at} {utc} /> ·
        <a class="mono" {...nav(latest.route)}>{latest.label}</a
        >{:else if names.some((name) => overview[name].busy)}<span class="muted"
          >Reading…</span
        >{:else}<span class="muted">No records read</span>{/if}
      {#if !complete && !names.some((name) => overview[name].busy)}<span
          class="summary-partial"
          >Partial read · a newer record may exist in an unavailable section</span
        >{/if}
    </dd>
  </div>
  <div>
    <dt>Captures archived</dt>
    {@render total(
      overview.captures,
      { view: "captures", query: "", offset: 0 },
      "captures",
    )}
  </div>
  <div>
    <dt>Recorded failures</dt>
    {@render total(overview.failures, operationRoute("errors"), "operations")}
  </div>
  <div>
    <dt>Deployment &amp; recovery</dt>
    {@render total(
      overview.deployments,
      operationRoute("deployments"),
      "operations",
    )}
  </div>
  <div>
    <dt>Amp</dt>
    {@render total(overview.amp, operationRoute("amp"), "operations")}
  </div>
</dl>

<div class="overview-grid">
  <section class="panel span-2" aria-labelledby="overview-failures">
    <header class="panel-head">
      <h2 id="overview-failures">Recorded failures to inspect</h2>
      <span class="panel-meta"
        >Last observed operation first · matching signatures do not establish a
        shared cause</span
      >
    </header>
    {@render sectionState(
      "failures",
      overview.failures,
      "recorded failures",
      "No operation in the archive carries a failure marker. Sources that never published cannot be represented here.",
    )}
    {#if overview.failures.data?.items.length}
      <div class="table-wrap">
        <table class="data-table overview-failures">
          <thead
            ><tr
              ><th scope="col">Operation</th><th scope="col"
                >Recorded failure</th
              ><th scope="col" class="num col-optional">Same signature</th><th
                scope="col"
                class="col-optional">Failure observed</th
              ><th scope="col" class="col-optional">Last recorded state</th></tr
            ></thead
          >
          <tbody>
            {#each overview.failures.data.items as item (item.latest.operationId)}
              {@const failure = item.failure ?? item.latest}
              <tr>
                <td
                  ><a
                    class="mono cell-id"
                    title={item.latest.operationId}
                    {...nav(
                      operationRoute("errors", {
                        id: item.latest.operationId,
                      }),
                    )}>{item.latest.operationId}</a
                  ><span class="cell-sub"
                    >{sourceLabel[item.latest.source]}</span
                  ><span class="cell-sub failure-time"
                    ><span class="sr-only">Failure observed: </span><Time
                      value={failure.observedAt}
                      {utc}
                      compact
                    /></span
                  ></td
                >
                <td class="cell-wrap"
                  ><code>{failure.phase ?? "phase unknown"}</code> ·
                  <code>{failure.reason ?? statusLabel(failure.status)}</code
                  ></td
                >
                <td class="num col-optional"
                  >{#if item.failureKey}<a
                      title="Operations with the same source, phase and reason"
                      {...nav(
                        operationRoute("errors", {
                          failureKey: item.failureKey,
                        }),
                      )}>{item.matchingFailures}</a
                    >{/if}</td
                >
                <td class="col-optional"
                  ><Time value={failure.observedAt} {utc} compact /></td
                >
                <td class="col-optional"><StateBadge event={item.latest} /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <a class="panel-foot" {...nav(operationRoute("errors"))}
        >All {overview.failures.data.total.toLocaleString()} recorded failures<ArrowRight
          size={13}
          aria-hidden="true"
        /></a
      >
    {/if}
  </section>

  <div class="span-2">
    <ControllerFacts
      controller={overview.controller}
      loading={operationReads.some((read) => read.busy)}
      failed={operationReads.every((read) => read.error === "failed")}
      {utc}
      {onnavigate}
      onretry={() => onretry("deployments")}
    />
  </div>

  <section class="panel span-2" aria-labelledby="overview-captures">
    <header class="panel-head">
      <h2 id="overview-captures">Recent captures</h2>
      <span class="panel-meta">Reporter text is not a verified diagnosis</span>
    </header>
    {@render sectionState(
      "captures",
      overview.captures,
      "captures",
      "No captures have been uploaded to this archive.",
    )}
    {#if overview.captures.data?.items.length}
      <div class="table-wrap">
        <table class="data-table">
          <thead
            ><tr
              ><th scope="col">Capture</th><th scope="col">Reported reason</th
              ><th scope="col" class="col-optional">Mode</th><th scope="col"
                >Captured</th
              ><th scope="col" class="num col-optional">Size</th></tr
            ></thead
          >
          <tbody>
            {#each overview.captures.data.items.slice(0, 6) as item (item.id)}
              <tr>
                <td
                  ><a
                    class="mono"
                    title={item.id}
                    {...nav({ view: "capture", id: item.id, page: "evidence" })}
                    >{item.id.slice(0, 8)}</a
                  ></td
                >
                <td class="cell-reason" title={item.reason}
                  >{item.reason || "No reason provided"}</td
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
      <a class="panel-foot" {...nav({ view: "captures", query: "", offset: 0 })}
        >All {overview.captures.data.total.toLocaleString()} captures<ArrowRight
          size={13}
          aria-hidden="true"
        /></a
      >
    {/if}
  </section>

  <section class="panel" aria-labelledby="overview-deployments">
    <header class="panel-head">
      <h2 id="overview-deployments">Deployment &amp; recovery records</h2>
    </header>
    {@render sectionState(
      "deployments",
      overview.deployments,
      "deployment records",
      "No deployment or recovery operation has been archived.",
    )}
    {#if overview.deployments.data?.items.length}
      <div class="table-wrap">
        <table class="data-table">
          <thead
            ><tr
              ><th scope="col">Operation</th><th scope="col">Recorded state</th
              ><th scope="col" class="col-optional">Revision</th><th scope="col"
                >Last observed</th
              ></tr
            ></thead
          >
          <tbody>
            {#each overview.deployments.data.items as item (item.latest.operationId)}
              <tr>
                <td
                  ><a
                    class="mono cell-id"
                    title={item.latest.operationId}
                    {...nav(
                      operationRoute("deployments", {
                        id: item.latest.operationId,
                      }),
                    )}>{item.latest.operationId}</a
                  ><span class="cell-sub"
                    >{sourceLabel[item.latest.source]}{#if item.latest.phase}
                      · {item.latest.phase}{/if}</span
                  ></td
                >
                <td><StateBadge event={item.latest} /></td>
                <td class="col-optional"
                  ><Revision value={item.latest.revision} /></td
                >
                <td><Time value={item.lastObservedAt} {utc} compact /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <a class="panel-foot" {...nav(operationRoute("deployments"))}
        >All {overview.deployments.data.total.toLocaleString()} deployment &amp; recovery
        operations<ArrowRight size={13} aria-hidden="true" /></a
      >
    {/if}
  </section>

  <section class="panel" aria-labelledby="overview-amp">
    <header class="panel-head">
      <h2 id="overview-amp">Amp activity</h2>
      <span class="panel-meta">Completed means execution ended</span>
    </header>
    {@render sectionState(
      "amp",
      overview.amp,
      "Amp activity",
      "No DEBUGSHARE, owner Amp task or coding operation has been archived.",
    )}
    {#if overview.amp.data?.items.length}
      <div class="table-wrap">
        <table class="data-table">
          <thead
            ><tr
              ><th scope="col">Operation</th><th scope="col">Recorded state</th
              ><th scope="col" class="col-optional">Amp thread</th><th
                scope="col">Last observed</th
              ></tr
            ></thead
          >
          <tbody>
            {#each overview.amp.data.items as item (item.latest.operationId)}
              <tr>
                <td
                  ><a
                    class="mono cell-id"
                    title={item.latest.operationId}
                    {...nav(
                      operationRoute("amp", { id: item.latest.operationId }),
                    )}>{item.latest.operationId}</a
                  ><span class="cell-sub"
                    >{sourceLabel[item.latest.source]}</span
                  ></td
                >
                <td><StateBadge event={item.latest} /></td>
                <td class="col-optional"
                  >{#if item.latest.threadId}<a
                      class="mono"
                      href={threadHref(item.latest.threadId)}
                      target="_blank"
                      rel="noreferrer"
                      title={item.latest.threadId}
                      >{item.latest.threadId.slice(0, 10)}</a
                    >{:else}<span class="muted">No thread in latest event</span
                    >{/if}</td
                >
                <td><Time value={item.lastObservedAt} {utc} compact /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <a class="panel-foot" {...nav(operationRoute("amp"))}
        >All {overview.amp.data.total.toLocaleString()} Amp operations<ArrowRight
          size={13}
          aria-hidden="true"
        /></a
      >
    {/if}
  </section>
</div>
<p class="page-foot">
  Retained evidence does not establish current service health. Counts are
  archive totals for each recorded scope.
</p>
