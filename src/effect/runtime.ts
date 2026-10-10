// Not the package index: it loads NodeSdk, which needs @opentelemetry/sdk-trace-node.
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import { Layer, ManagedRuntime } from "effect";
import { effectTracer } from "../telemetry/index.js";

/** Built when the runtime first runs, after initializeTelemetry. Without a
 * telemetry backend, Effect keeps its default in-memory tracer. */
export const TelemetryLayer = Layer.suspend(() => {
  const tracer = effectTracer();
  return tracer
    ? OtelTracer.layerWithoutOtelTracer.pipe(
        Layer.provide(Layer.succeed(OtelTracer.OtelTracer, tracer)),
      )
    : Layer.empty;
});

/** The one runtime per process that Rivet steps and legacy async code run Effect programs on. */
export const makeJuneRuntime = () => ManagedRuntime.make(TelemetryLayer);
export type JuneRuntime = ReturnType<typeof makeJuneRuntime>;
