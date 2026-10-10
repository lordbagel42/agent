import {
  CaptureUpdateAction,
  Excalidraw,
  restoreElements,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createRoot } from "react-dom/client";
import type { WorkflowView } from "./contracts.js";
import { mergeScene, parseScene, type SceneElement } from "./scene.js";

Object.assign(window, { EXCALIDRAW_ASSET_PATH: "/artifacts/assets/" });
const id = document.body.dataset.artifact;
const base = `/artifacts/${id}`;
const content = document.getElementById("content");
const status = document.getElementById("status");
const title = document.getElementById("title");
let api: ExcalidrawImperativeAPI | undefined;
let pending: SceneElement[] = [];
let generation = 0;
let mounted = false;
let sending = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let events: EventSource | undefined;
let observed = "";
let renderedRevision = 0;
const preview = location.search === "?preview";
const sceneVersion = (elements: readonly SceneElement[]) =>
  JSON.stringify(
    elements.map(({ id, version, versionNonce, isDeleted }) => [
      id,
      version,
      versionNonce,
      isDeleted,
    ]),
  );
function state(text: string) {
  if (status) status.textContent = text;
}
function locked() {
  stopped = true;
  pending = [];
  clearTimeout(timer);
  events?.close();
  if (content) content.replaceChildren();
  state("Access changed. Reopen this page to unlock.");
}
async function flush() {
  if (sending || !pending.length || stopped) return;
  sending = true;
  const batch = pending;
  pending = [];
  state("Saving…");
  try {
    const response = await fetch(`${base}/scene`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation, elements: batch }),
    });
    if (response.status === 401 || response.status === 409) {
      locked();
      return;
    }
    if (!response.ok) throw new Error("save_failed");
    await sync();
  } catch {
    pending = mergeScene(batch, pending);
    state("Offline — edits waiting to sync");
  } finally {
    sending = false;
    if (!stopped && pending.length)
      timer = setTimeout(() => {
        void flush();
      }, 1500);
  }
}
function workflow(view: WorkflowView) {
  if (!content) return;
  const expanded = new Set(
    Array.from(content.querySelectorAll("details[open]")).map(
      (node) => node.querySelector("summary span")?.textContent,
    ),
  );
  const section = document.createElement("section");
  section.className = "workflow";
  const heading = document.createElement("h1");
  heading.textContent = view.name;
  const note = document.createElement("p");
  note.textContent = `Recorded workflow status: ${view.status}. This view cannot run, cancel, or change a workflow.`;
  const list = document.createElement("ol");
  for (const operation of view.operations) {
    const item = document.createElement("li");
    const details = document.createElement("details");
    details.open = expanded.has(operation.name);
    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.textContent = operation.name;
    const outcome = document.createElement("span");
    outcome.textContent = operation.status;
    const explanation = document.createElement("p");
    explanation.textContent =
      "Observed execution receipt. Inputs, source code, and returned data are not shared in this view.";
    summary.append(name, outcome);
    details.append(summary, explanation);
    item.append(details);
    list.append(item);
  }
  if (!view.operations.length) {
    const empty = document.createElement("p");
    empty.textContent = "No operation receipts yet.";
    section.append(empty);
  }
  section.prepend(heading, note, list);
  content.replaceChildren(section);
}
async function sync() {
  if (stopped || !content) return;
  try {
    const response = await fetch(`${base}/data`, { cache: "no-store" });
    if (response.status === 401 || response.status === 410) {
      locked();
      return;
    }
    if (!response.ok) throw new Error("load_failed");
    const data = await response.json();
    if (stopped) return;
    if (generation && data.generation !== generation) {
      locked();
      return;
    }
    generation = data.generation;
    if (title) title.textContent = data.title;
    if (data.kind === "board") {
      const elements = parseScene(JSON.parse(data.content));
      if (!mounted) {
        mounted = true;
        observed = sceneVersion(elements);
        const canvas = document.createElement("div");
        canvas.id = "canvas";
        content.append(canvas);
        createRoot(canvas).render(
          <Excalidraw
            theme="light"
            viewModeEnabled={preview}
            zenModeEnabled={preview}
            initialData={{
              elements: restoreElements(
                elements as Parameters<typeof restoreElements>[0],
                null,
              ),
              scrollToContent: true,
            }}
            excalidrawAPI={(value: ExcalidrawImperativeAPI) => {
              api = value;
              // Frame the drawing for the static chat preview.
              if (preview)
                setTimeout(() =>
                  value.scrollToContent(undefined, {
                    fitToContent: true,
                    animate: false,
                  }),
                );
            }}
            UIOptions={{
              tools: { image: false },
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                toggleTheme: false,
              },
            }}
            onChange={(next: readonly unknown[]) => {
              if (!api || stopped || preview) return;
              try {
                const checked = parseScene(next);
                const signature = sceneVersion(checked);
                if (signature === observed) return;
                observed = signature;
                pending = mergeScene(pending, checked);
                clearTimeout(timer);
                timer = setTimeout(() => {
                  void flush();
                }, 250);
              } catch {
                state("Only vector shapes and text can be shared.");
              }
            }}
          />,
        );
      } else if (api) {
        const current = parseScene(api.getSceneElementsIncludingDeleted());
        const merged = mergeScene(elements, mergeScene(current, pending));
        if (sceneVersion(current) !== sceneVersion(merged)) {
          observed = sceneVersion(merged);
          api.updateScene({
            elements: restoreElements(
              merged as Parameters<typeof restoreElements>[0],
              null,
            ),
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      }
    } else if (data.kind === "workflow") workflow(data.workflow);
    else if (!mounted) {
      mounted = true;
      const frame = document.createElement("iframe");
      frame.title = data.title;
      frame.className = "document";
      frame.setAttribute("sandbox", "");
      frame.src = `${base}/document`;
      content.append(frame);
    } else if (data.revision !== renderedRevision) {
      const frame = content.querySelector("iframe");
      if (frame) frame.src = `${base}/document`;
    }
    renderedRevision = data.revision;
    document.body.dataset.ready = "true";
    state(
      pending.length
        ? "Changes waiting to sync"
        : `${data.visibility === "private" ? "PIN-protected" : "Public"} · revision ${data.revision}`,
    );
  } catch {
    state("Connection interrupted. Reconnecting…");
  }
}
void sync();
if (!preview) {
  events = new EventSource(`${base}/events`);
  events.onmessage = (message) => {
    if (message.data === "locked") locked();
    else void sync();
  };
  events.onerror = () => state("Connection interrupted. Reconnecting…");
}
window.addEventListener("online", () => {
  void sync();
  void flush();
});
