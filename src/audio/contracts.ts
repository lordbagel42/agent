import { Context, Effect, Layer, Schema } from "effect";
import {
  Int,
  isPattern,
  TrimmedString,
  Uuid,
  withDefault,
} from "../effect/schema.js";

export class AudioError extends Schema.TaggedError<AudioError>()("AudioError", {
  code: Schema.Literals([
    "unavailable",
    "busy",
    "rejected",
    "cancelled",
    "invalid_media",
    "media_overflow",
    "media_disconnected",
    "provider_failed",
    "authentication_required",
    "configuration_rejected",
    "cleanup_unconfirmed",
    "protocol_error",
    "deadline",
    "unknown",
  ]),
}) {}
export const audioError = (code: AudioError["code"]) =>
  new AudioError({ code });
export const audioAttempt = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (e) => (e instanceof AudioError ? e : audioError("unknown")),
  });

const endpointName = Schema.String.check(isPattern(/^[a-zA-Z0-9_-]{1,64}$/));
export const audioCommandSchema = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({
    action: Schema.Literal("call"),
    endpoint: endpointName,
    reason: TrimmedString({ min: 1, max: 1000 }),
  }),
  Schema.Struct({ action: Schema.Literal("hangup"), id: Uuid }),
]);
export type AudioCommand = typeof audioCommandSchema.Type;

export const audioConfigSchema = Schema.Struct({
  enabled: Schema.Boolean.pipe(withDefault(true)),
  voice: Schema.Literals([
    "cove",
    "juniper",
    "maple",
    "spruce",
    "ember",
    "vale",
    "breeze",
    "arbor",
    "sol",
  ]).pipe(withDefault("cove")),
  maxDurationSeconds: Int({ minimum: 30, maximum: 1800 }).pipe(
    withDefault(600),
  ),
  endpoints: Schema.Record(
    endpointName,
    Schema.Struct({
      kind: Schema.Literal("switchboard"),
      origin: Schema.String.check(
        Schema.makeFilter((value: string) => {
          try {
            const u = new URL(value);
            return u.protocol === "https:" && u.origin === value;
          } catch {
            return false;
          }
        }),
      ),
      tokenEnv: Schema.String.check(isPattern(/^[A-Z_][A-Z0-9_]*$/)),
      // Explicit device trust, never inferred from caller ID or spoken identity.
      trustedOwnerDevice: Schema.Literal(true),
    }),
  ).pipe(withDefault({})),
});
export type AudioConfig = typeof audioConfigSchema.Type;

/** Canonical transport-independent audio: 20 ms mono s16le, 48 kHz, 1920 bytes.
 * Adapters own conversion and pacing. No WAV headers, metadata or base64. */
export const AUDIO_FRAME_BYTES = 1920;
export interface AudioConnection {
  readonly id: string;
  readonly connected: Promise<void>;
  readonly ended: Promise<void>;
  send(frame: Uint8Array): void;
  clearPlayback(): void;
  close(): Promise<void>;
}
export interface CallTransport {
  readonly name: string;
  /** Stable UUID supplied by the host; lost replies never justify a new key. */
  dial(
    idempotencyKey: string,
    maxSeconds: number,
    signal: AbortSignal,
  ): Promise<string>;
  attach(
    id: string,
    input: (frame: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<AudioConnection>;
  end(id: string): Promise<void>;
  inspect(id: string): Promise<{ state: string; reason: string | null }>;
  incoming(signal: AbortSignal): Promise<string[]>;
}

export interface VoiceSession {
  readonly ended: Promise<void>;
  input(frame: Uint8Array): void;
  speak(text: string): Promise<void>;
  close(): Promise<void>;
}
export interface CallReceipt {
  id: string;
  endpoint: string;
  direction: "inbound" | "outbound";
  state: "starting" | "dialing" | "connected" | "ended" | "failed" | "unknown";
  providerId: string | null;
  maxDurationSeconds: number;
  reservationAttempted: boolean;
  code: string | null;
  createdAt: number;
  updatedAt: number;
}

export class Calling extends Context.Service<
  Calling,
  {
    command(
      command: AudioCommand,
      operationId: string,
      current: () => boolean,
    ): Effect.Effect<string, AudioError>;
    status(): string;
    isSettled(): boolean;
    start(): void;
    close(): Promise<void>;
  }
>()("june/audio/Calling") {
  static layer(service: Calling["Service"]) {
    return Layer.succeed(Calling, service);
  }
}

export const AUDIO_HELP =
  "Audio calls use stock Codex conversational voice through June's calling service. In an authorized owner-private task use audioCall:{action:'status'} to discover endpoints and exact missing prerequisites; audioCall:{action:'call',endpoint,reason} calls that registered device, or {action:'hangup',id} ends an existing call. No compulsory per-call approval: Raygen has asked June to call his configured desk phone when she judges it useful. Never invent a destination or use a new operation to repeat an uncertain call. Starting/dialing is not answered; only connected confirms media. Switchboard owns extension 333, handset ringing, busy/quiet-hours policy and the 8-kHz phone connection. Incoming 333 calls are admitted by the configured trusted-device endpoint, not by speech or caller ID. Codex handles natural conversation and interruptions; speech is not verbatim synthesis. The voice agent can hand a task to June's normal execution path; tasks can continue after hangup, but old replies are never played into a new call. No ambient microphone capture or raw-audio recording. Calls consume the configured ChatGPT subscription; no API-key speech fallback. Call metadata is retained without audio or transcripts; delegated task text follows ordinary June retention. Active calls block deployment drain. Missing credentials, Codex login or Chromium are setup blockers, not permission to bypass them. Configuration alone is not live verification.";
