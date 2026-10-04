import type { DebugSnapshot } from "./types.js";

export interface EvidenceRow {
  path: string;
  source: "Coordinator" | "Activity" | "Timing";
  kind: string;
  title: string;
  status: string;
  time: number | null;
  timeLabel: string;
  payload: unknown;
  search: string;
}

export function timestamp(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" &&
          /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 8.64e15
    ? numeric
    : null;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown, fallback = "Not retained"): string {
  return typeof value === "string" && value.length ? value : fallback;
}

const pointer = (key: string) =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

function row(
  path: string,
  source: EvidenceRow["source"],
  kind: string,
  payload: unknown,
  title: string,
  status = "Recorded",
  time: number | null = null,
  timeLabel = "Time unknown",
): EvidenceRow {
  return {
    path,
    source,
    kind,
    payload,
    title,
    status,
    time,
    timeLabel,
    search:
      `${path} ${source} ${kind} ${title} ${status} ${JSON.stringify(payload)}`.toLowerCase(),
  };
}

function deliveryRow(
  path: string,
  source: EvidenceRow["source"],
  payload: unknown,
  title: string,
) {
  const item = record(payload);
  return row(
    path,
    source,
    "Delivery",
    payload,
    title,
    text(record(item.result).status, text(item.phase)),
    timestamp(item.outcomeObservedAt),
    "Outcome observed",
  );
}

/** Project only explicitly retained fields. IDs are opaque, markers are not spans,
 * and repeated evidence in different sources is not independent corroboration. */
export function projectSnapshot(snapshot: DebugSnapshot) {
  const data = record(snapshot.data);
  const wrapped = Object.hasOwn(data, "coordinator");
  const coordinator = wrapped ? record(data.coordinator) : data;
  const base = wrapped ? "/data/coordinator" : "/data";
  const activity = wrapped ? record(data.activity) : {};
  const timeline: EvidenceRow[] = [];
  const messages: EvidenceRow[] = [];
  const deliveries: EvidenceRow[] = [];
  const logs: EvidenceRow[] = [];

  array(record(coordinator.timings).traces).forEach((value, traceIndex) => {
    const trace = record(value);
    const receivedAt = timestamp(trace.receivedAt);
    array(trace.observations).forEach((payload, index) => {
      const observation = record(payload);
      const ms =
        typeof observation.ms === "number" &&
        Number.isFinite(observation.ms) &&
        observation.ms >= 0
          ? observation.ms
          : null;
      logs.push(
        row(
          `${base}/timings/traces/${traceIndex}/observations/${index}`,
          "Timing",
          "Timing stage",
          payload,
          `${text(trace.inputId).slice(0, 12)} · ${text(observation.stage)}`,
          ms === null ? "Elapsed unknown" : `+${ms.toFixed(1)} ms`,
          receivedAt === null || ms === null
            ? null
            : timestamp(receivedAt + ms),
          "Received + elapsed",
        ),
      );
    });
  });

  for (const [id, payload] of Object.entries(record(coordinator.events))) {
    const item = record(payload);
    const event = record(item.event);
    timeline.push(
      row(
        `${base}/events/${pointer(id)}`,
        "Coordinator",
        "Event",
        payload,
        text(event.text, text(event.type, id)),
        item.done === true
          ? "Workflow complete"
          : item.deferred === true
            ? "Deferred"
            : "Recorded",
        timestamp(event.occurredAt),
        "Event occurred",
      ),
    );
  }
  for (const [id, payload] of Object.entries(record(coordinator.pending))) {
    const item = record(payload);
    timeline.push(
      row(
        `${base}/pending/${pointer(id)}`,
        "Coordinator",
        "Pending input",
        payload,
        text(item.text, id),
        "Pending",
        timestamp(item.occurredAt),
        "Event occurred",
      ),
    );
  }
  for (const [field, kind] of [
    ["modelInvocations", "Model marker"],
    ["webInvocations", "Web marker"],
  ] as const) {
    for (const [id, payload] of Object.entries(record(coordinator[field]))) {
      timeline.push(
        row(
          `${base}/${field}/${pointer(id)}`,
          "Coordinator",
          kind,
          payload,
          id,
          text(payload),
        ),
      );
    }
  }
  for (const [id, payload] of Object.entries(record(coordinator.deliveries))) {
    deliveries.push(
      deliveryRow(
        `${base}/deliveries/${pointer(id)}`,
        "Coordinator",
        payload,
        id,
      ),
    );
  }
  array(activity.turns).forEach((payload, index) => {
    const item = record(payload);
    const path = `/data/activity/turns/${index}`;
    timeline.push(
      row(
        path,
        "Activity",
        "Activity turn",
        payload,
        text(item.eventId),
        text(item.inference, "Inference not retained"),
        timestamp(item.receivedAt),
        "Input received",
      ),
    );
    array(item.deliveries).forEach((delivery, deliveryIndex) => {
      deliveries.push(
        deliveryRow(
          `${path}/deliveries/${deliveryIndex}`,
          "Activity",
          delivery,
          `${text(item.eventId)} · delivery ${deliveryIndex + 1}`,
        ),
      );
    });
  });
  for (const [items, path, source] of [
    [coordinator.history, `${base}/history`, "Coordinator"],
    [activity.history, "/data/activity/history", "Activity"],
  ] as const) {
    array(items).forEach((payload, index) => {
      const item = record(payload);
      messages.push(
        row(
          `${path}/${index}`,
          source,
          "Message",
          payload,
          text(item.content, "Non-text message · inspect payload"),
          text(item.role, "Role not retained"),
        ),
      );
    });
  }
  timeline.push(...logs, ...deliveries, ...messages);
  const modelRequest = coordinator.modelRequest;
  const modelRequestPath = `${base}/modelRequest`;
  if (modelRequest !== undefined && modelRequest !== null) {
    timeline.push(
      row(
        modelRequestPath,
        "Coordinator",
        "Model request",
        modelRequest,
        "Retained host request",
      ),
    );
  }
  // Stable source order for unknown times. Do not substitute capture or input time.
  timeline.sort((left, right) => {
    if (left.time === null) return right.time === null ? 0 : 1;
    if (right.time === null) return -1;
    return left.time - right.time;
  });
  return {
    timeline,
    messages,
    deliveries,
    logs,
    modelRequest,
    modelRequestPath,
    activityAvailable:
      wrapped &&
      data.activity !== null &&
      typeof data.activity === "object" &&
      !Array.isArray(data.activity),
    activityCapturedAt: timestamp(data.activityCapturedAt),
  };
}

export function filterRows(rows: EvidenceRow[], query: string) {
  const needle = query.trim().toLowerCase();
  return needle ? rows.filter((item) => item.search.includes(needle)) : rows;
}

export function pageItems<T>(items: T[], requestedPage: number, size = 40) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  return { items: items.slice(page * size, (page + 1) * size), page, pages };
}
