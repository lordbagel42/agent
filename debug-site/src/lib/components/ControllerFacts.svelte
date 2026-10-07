<script lang="ts">
  import { ArrowRight, RotateCw } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { age, link, threadHref } from "$lib/display.js";
  import { operationRoute, type Route } from "$lib/route.js";
  import type { OperationEvent } from "$lib/types.js";
  import Revision from "./Revision.svelte";
  import StateBadge from "./StateBadge.svelte";
  import Time from "./Time.svelte";

  let {
    controller,
    loading,
    failed,
    utc,
    onnavigate,
    onretry,
  }: {
    controller: OperationEvent | null | undefined;
    loading: boolean;
    failed: boolean;
    utc: boolean;
    onnavigate: (route: Route) => void;
    onretry: () => void;
  } = $props();
  const id = $props.id();
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (controller) now = Date.now();
  });
  const control = $derived(controller?.controller);
  const stale = $derived(
    controller
      ? now - controller.observedAt > 300_000 || controller.observedAt > now
      : false,
  );
  const nav = (route: Route) => link(route, onnavigate);
</script>

<section class="panel" aria-labelledby={`${id}-heading`}>
  <header class="panel-head">
    <h2 id={`${id}-heading`}>Latest controller observation</h2>
    {#if controller}<a
        class="panel-link"
        {...nav(operationRoute("deployments", { id: controller.operationId }))}
        >Controller history <ArrowRight size={13} aria-hidden="true" /></a
      >{/if}
  </header>
  {#if controller === undefined && loading}<p class="panel-note" role="status">
      Reading the latest archived controller observation…
    </p>
  {:else if controller === undefined && failed}<div
      class="panel-note"
      role="alert"
    >
      <p>
        Controller observation unavailable. No current deployment state can be
        inferred.
      </p>
      <Button variant="outline" size="sm" onclick={onretry}
        ><RotateCw size={13} aria-hidden="true" />Retry</Button
      >
    </div>
  {:else if !controller}<p class="panel-note">
      No controller observation received. The source may not be connected or
      publishing yet. This is not a health signal.
    </p>
  {:else}
    <div class="observed-line">
      <span class="observed-at"
        >Observed <strong><Time value={controller.observedAt} {utc} /></strong
        ></span
      >
      <span class="muted">{age(now, controller.observedAt)}</span>
      {#if stale}<span class="stale-note"
          >{controller.observedAt > now
            ? "Clock skew · current state unknown"
            : "Over 5 minutes old · may no longer describe the controller"}</span
        >{/if}
      <span class="observed-state"
        >Recorded state <StateBadge event={controller} /><code
          >{control?.phase ?? controller.phase ?? "phase unknown"}</code
        ></span
      >
    </div>
    {#if control}
      <dl class="fact-grid">
        <div>
          <dt>Recorded active revision</dt>
          <dd><Revision value={control.activeRevision} /></dd>
        </div>
        <div>
          <dt>Observed revision</dt>
          <dd><Revision value={control.observedRevision} /></dd>
        </div>
        <div>
          <dt>Target revision</dt>
          <dd><Revision value={control.targetRevision} /></dd>
        </div>
        <div>
          <dt>Controller revision</dt>
          <dd><Revision value={control.controllerRevision} /></dd>
        </div>
        <div>
          <dt>Blocked</dt>
          <dd>{control.blocked ? "Blocked" : "Not blocked"}</dd>
        </div>
        <div>
          <dt>Operator hold</dt>
          <dd>{control.operatorHold ? "Hold recorded" : "No hold recorded"}</dd>
        </div>
        <div>
          <dt>Retry attempts</dt>
          <dd>{control.retryAttempts ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Recorded retry time</dt>
          <dd>
            {#if control.retryAt !== null}<Time
                value={control.retryAt}
                {utc}
              />{:else}<span class="muted">Not recorded</span>{/if}
          </dd>
        </div>
        <div>
          <dt>Recovery incident</dt>
          <dd>
            {#if control.recoveryIncident}<a
                class="mono"
                {...nav(
                  operationRoute("deployments", {
                    id: control.recoveryIncident,
                  }),
                )}>{control.recoveryIncident}</a
              >{:else}<span class="muted">None recorded</span>{/if}
          </dd>
        </div>
        <div>
          <dt>Recovery thread / owner</dt>
          <dd>
            {#if control.recoveryThreadId}<a
                class="mono"
                href={threadHref(control.recoveryThreadId)}
                target="_blank"
                rel="noreferrer"
                title={control.recoveryThreadId}
                >{control.recoveryThreadId.slice(0, 10)}</a
              >{:else}<span class="muted">No thread</span>{/if}
            /
            {#if control.recoveryOwner}<a
                class="mono"
                href={threadHref(control.recoveryOwner)}
                target="_blank"
                rel="noreferrer"
                title={control.recoveryOwner}
                >{control.recoveryOwner.slice(0, 10)}</a
              >{:else}<span class="muted">no owner</span>{/if}
          </dd>
        </div>
      </dl>
      <details class="fact-details">
        <summary
          >Queued revisions · {control.queuedRevisions.length} listed{#if control.omittedQueueCount > 0},
            {control.omittedQueueCount} omitted by source{/if}</summary
        >
        {#if control.queuedRevisions.length}<ol class="revision-list">
            {#each control.queuedRevisions as revision, index (index)}<li>
                <Revision value={revision} /><code class="muted"
                  >{revision}</code
                >
              </li>{/each}
          </ol>{:else}<p class="panel-note">
            No queued revisions in this observation.
          </p>{/if}
      </details>
    {:else}<p class="panel-note">
        Controller fields were not recorded with this event.
      </p>{/if}
  {/if}
</section>
