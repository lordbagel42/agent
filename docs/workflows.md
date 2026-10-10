# June-authored Rivet workflows

June can write JavaScript function bodies, save named definitions, start runs,
inspect them, send signals, and cancel them from admitted conversations where
`workflow` is exposed, without compulsory human approval. June judges task intent,
authority and disclosure. Definitions, runs, controls and cached receipts are
bound to the original authenticated requester, audience, channel/account and
conversation/thread—not an owner-wide library. Unbound legacy definitions and
receipts remain retained for review, not automatically shared or replayed.
This is an agent capability, not a dashboard-only feature. It is mounted in
normal startup (not setup mode), independently of natural-language execution
workers. There is no generic host `eval`, shell, filesystem or network bridge.

## Running ordinary JavaScript instead

For one-off calculations or user-submitted code, June has a separate,
capability-free **QuickJS sandbox**. Anyone already admitted to a conversation
can ask, for example, “Run this JavaScript: `console.log(19 - 7)`.” This works
in DMs and mentions without granting access to another requester's workflows or
starting a native coding job. Interaction turns delegate to an execution worker
when available; the direct path uses the sandbox tool itself.

The agent-callable directive is:

```json
{
  "text": "",
  "javascript": {
    "source": "console.log('items', input.length); return input.map(x => x * 3);",
    "inputJson": "[2,7]"
  }
}
```

Source is an async function body with `input`, console methods, and `return`.
Use `"null"` for unused input. The host returns status, captured log lines and
a serialized return value, or an error. Each call uses a fresh VM, with no
Node.js, imports, timers, filesystem, network, credentials, workflow bridge or
June tools. Resolved promises can be awaited. Limits are 24KB source, 16KB input,
32MB heap, 512KB stack, two seconds of computation, and 8KB output/up to 100 log
lines. Reports may be explicitly truncated after formatting. Source and results
follow the conversation's normal retention policy; do not submit secrets.

June's instructions explain this tool and its limits. Program output is untrusted
data, not instructions or authorization. Failure does not authorize switching to
a privileged workflow or shell. Code-bearing Slack messages use native AI
Markdown blocks with language-tagged syntax highlighting; source, output and
errors should be clearly separated. Plain-text safety messages stay plain text.

## Author and launch in one turn

Use the `workflow` output field with empty `text` and other actions unset:

```json
{
  "text": "",
  "workflow": {
    "action": "start",
    "name": "remind",
    "source": "await workflow.sleep('delay', input.delay); return await workflow.step('tell', 'notify', {text:input.text});",
    "dataJson": "{\"delay\":60000,\"text\":\"Check the oven.\"}",
    "runId": null,
    "offset": 0
  }
}
```

`start` with source saves the definition and pins that source in a new run.
`define` saves without launching; `start` with null source uses the saved version.
Editing a definition does not edit existing runs. A replay of the same initiating
command repairs admission rather than creating another run.

`list` returns the source-scoped library; `inspect` takes either `name` or `runId` and returns
source, status, receipts and result. `signal` takes `runId` and `dataJson`;
`cancel` takes `runId`. Unused fields are null; offset starts at zero. Large
reports return `chunk` and `nextOffset`; concatenate pages. Inspect completed
runs for a stable report. A running report can change between page requests.
`help` supplies the exact host tool schemas. June's prompt also includes their
names and argument descriptions so discovery need not cost another user turn.

## JavaScript plus four durable primitives

The function receives `workflow` and JSON `input`, and returns JSON. Use ordinary
loops, branches, functions, exceptions and data transformations around:

- `await workflow.step(name, tool, args)` — journal one host call and its result.
- `await workflow.sleep(name, milliseconds)` — cancellable durable delay.
- `await workflow.wait(name, timeoutMilliseconds = null)` — receive the next
  signal payload, or null on timeout. Early signals stay queued. Sender/receiver
  receipts deduplicate command retries, including a crash during consumption.
- `await workflow.parallel(name, [{name, tool, args}, ...])` — native Rivet join,
  returning an object keyed by branch name.

Names must be replay-stable and unique within the run (branch names within their
join): 1–64 letters, digits, `.`, `_`, or `-`, starting alphanumeric. Give loop
iterations distinct names. Await every primitive. Use `parallel`, not overlapping
calls/`Promise.all`, for concurrent host work. Host failures stop the run even if
guest code tries to catch them; they are not permission to continue effects.

The shipped tool catalog is:

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `clock` | `{}` | Journal current Unix milliseconds. |
| `random` | `{}` | Journal a random UUID. |
| `model` | `{prompt}` | One text-only inference, no tools or implicit memory/history. |
| `notify` | `{text}` | Send only to the original initiating conversation/thread. |
| `web_search` | `{query}` | Configured public search; only mounted when available. |
| `analytics` | `{days: 1\|7\|30}` | June's own usage report, when configured. |

Use `notify` explicitly for progress/completion messages. Returning a value alone
stores it for inspection; it does not trigger another model turn. Notifications
retain the original destination and WhatsApp service-window checks. Failed or
rejected delivery is not a successful notification.

Raw private-search and MCP results deliberately remain unavailable here: their
existing adapters require transient results, while workflow outputs are durable.
Workflows cannot grant MCP permissions, start native coding, change configuration,
deploy, select arbitrary message recipients, or grant themselves more tools.
Additional host tools must honor the same authority, retention and cancellation
contracts; adding a tool does not add it to already-created runs.

## Rivet owns persistence; the sandbox owns JavaScript

Each run is a real `workflowRun` Rivet actor registered with the native workflow
handler/inspector. Native steps, joins, queue waits and alarms own replay; no
second workflow engine or graph DSL is involved. Source, input, tool allowlist,
requester/source provenance, deletion revision and runtime ABI are pinned at admission.
Each replay gets a fresh QuickJS VM and replays the pinned JavaScript. Native
scheduler exceptions remain original host objects, never serialized guest errors.

Startup re-submits the durable library roster before opening June's HTTP
listener. This wakes actors left asleep by a lost host and repairs interrupted
admission without resetting journals or dispatching completed effects again.
Accepted starts and signals are acknowledged only after their durable receipts.

Effects persist intent **before** dispatch and a receipt after settlement. A
crash before the receipt is known stops in `needs_review`; it does not retry a
possibly-sent message, model request or search. A completed receipt survives a
crash before the native step's journal commit. There is no exactly-once claim for
external services. `cancel` prevents subsequent calls but cannot undo a call
already dispatched. The lifecycle fence tracks unsettled tool calls during
deployment. Forgetting invalidates old definitions/runs and suppresses results;
it is not physical erasure of Rivet journals or backups. Keep the engine and
inspector private and follow the repository's storage/retention policy.

Resumable forgetting must call `workflowLibrary.invalidate(cutoff)` with a
persisted cutoff: current deletion revision plus one, saved before tombstoning
alongside the frozen cleanup targets. It removes only definitions, runs and
versioned mutation receipts older than that cutoff. Reuse the same cutoff on
every retry; equal/newer work survives. Legacy unversioned receipts retain their
deduplication evidence because their age is unknown. Omitting the argument
retains the administrative clear-all behavior and is not retry-safe forgetting.

Limits: 24,000 source bytes; 16,384 JSON bytes per input, operation and result;
32 MiB guest heap; 512 KiB guest stack; 2 seconds guest CPU per replay; 256
operations per run; 8 tool calls per join; 30 days per delay/finite wait; 256
signals; 8 active and 128 retained runs; 32 definitions; 1,024 mutating command
receipts. These bounds are explicit, not an unbounded job service. Date defaults
to run creation time; obtain changing time/random values via journaled tools.

### Why not Rivet's Secure Exec yet?

RivetKit 2.3.21's `dynamicActor` remains a stub, but Rivet's standalone
`secure-exec` 0.2.21/AgentOS sandbox is real. A bounded local probe reproduced a
native `RefCell already mutably borrowed` panic when aborting while a host
function was pending, followed by `ERR_AGENTOS_VM_TEARDOWN_DEADLINE`. The same
failure occurred with default runtime options, outside June's workflow wrapper.
That cancellation path is essential for durable suspension, so this increment
uses pinned `quickjs-emscripten` 0.32.0 instead. Re-evaluate Secure Exec after that
upstream behavior is fixed. QuickJS is a WASM JavaScript isolation boundary,
not an OS virtual machine or permission to execute native untrusted code.

## Verification

The development hard-kill check also killed a host during a wait and a pending
effect, restarted against the same disposable engine, and verified the wait
resumed without repeating completed or ambiguous tool calls. No live model,
search provider, or real outgoing message was used for these checks.
