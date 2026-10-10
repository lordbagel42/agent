import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

// This module runs only trusted adapters. Authored code remains inside QuickJS;
// worker_threads provides scheduling isolation, not the security boundary.
try {
  const signal = new AbortController().signal;
  let value;
  if (workerData.kind === "javascript") {
    const { runJavaScript } = await tsImport(
      "./javascript-vm.ts",
      import.meta.url,
    );
    parentPort.postMessage({ kind: "ready" });
    value = await runJavaScript(workerData.input, signal);
  } else {
    const { runWorkflowSource } = await tsImport(
      "../workflows/sandbox-vm.ts",
      import.meta.url,
    );
    const { source, input, createdAt } = workerData.input;
    parentPort.postMessage({ kind: "ready" });
    value = await runWorkflowSource(
      source,
      input,
      createdAt,
      (operation) =>
        new Promise((resolve) => {
          parentPort.once("message", (message) => resolve(message.value));
          parentPort.postMessage({ kind: "dispatch", operation });
        }),
      signal,
    );
  }
  parentPort.postMessage({ kind: "result", value });
} catch (error) {
  parentPort.postMessage({
    kind: "error",
    error: error instanceof Error ? error.message : "Sandbox failed.",
  });
}
