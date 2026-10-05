# Independent debug-site automatic updates

**Goal:** Ship the approved Timeline/Conversation increment, then automatically
update the independent debug site from trusted `lordbagel42/agent` main without
coupling its availability, data, or services to June.

**Architecture:** A separately installed, root-owned Python controller and
systemd timer on the debug host fetch public main without credentials. A distinct
unprivileged build service runs the installed preflight. Immutable bundles replace
only the site's `current` link. Readiness checks bind the loaded build revision
to the service MainPID. Rollback changes code only; interrupted effects latch an
operator fence. The controller cannot update itself from main.

**Constraints:** Preserve the archive, passkeys, credentials, ingress and June's
services. Use `/run/lock/june-debug-install.lock` for every live operation. Store
policy changes require a separately reviewed manual update/rebootstrap. Never
run repository code as root or use personal GitHub credentials. Status is bounded,
public-safe metadata; source publication, historical status and live readiness
are separate observations.

## Delivery and checks

- [x] Build exact published revision `206557b1bf68c13b5580125b17e26903e6f2f463`
  in an isolated build worktree. Run formatter/linter/type checks, focused tests,
  build, and a disposable-database artifact smoke test.
- [x] Install under the existing debug lock. Verify changed MainPID, exact loaded
  revision, public readiness, authenticated API boundary and Conversation shell.
  The Conversation thread independently verified both asset hashes and Chromium.
- [x] Add `scripts/deploy/debug_site.py` and focused state-machine tests. Exercise
  successful advancement, unchanged build inputs, failed candidate rollback,
  duplicate suppression, non-fast-forward main, storage-policy drift, and
  interrupted-operation fences before any systemd integration.
- [ ] Add installed `debug-site-preflight.sh`, service and timer. Build under a
  dedicated UID with bounded memory/time, no live archive/config access, frozen
  dependencies and disabled lifecycle hooks. Smoke-test the actual bundle on
  disposable data before promotion. Reject symlinks/hardlinks in promoted output.
- [x] Add `src/diagnostics/deployment.ts` and focused contract tests. Coordinate
  main/server and inspection/schema/prompt hooks with the Operations thread,
  which owns those files. Expose only validated phases, reasons, revisions and
  timestamps; bounded credential-free health reads never follow redirects.
- [ ] Verify June can discover and invoke owner-private
  `inspection:"debug-site-deployment"`; interaction agents delegate it. Keep the
  automation knowledge in interaction, execution and automated-event prompts.
- [ ] Run formatting, lint, types, targeted Python/TypeScript checks and Oracle
  review. Publish atomic changes to main without including concurrent work.
- [ ] Install reviewed controller policy and its provenance, bootstrap from a
  verified healthy immutable release, enable the timer, and observe one real
  automatic update followed by a no-op poll. Verify loaded revision, readiness,
  status inspection, unchanged archive permissions and independence from June.

The new controller, build script, units, status module and this document are owned
by this thread. Existing June deployer/dispatcher files and Operations UI belong
to other threads and are not part of this implementation.

The status module and isolated health hooks are published in `4925a18`. The
Operations thread owns the remaining June inspection/schema/prompt integration.
Oracle's deployment review identified cgroup settlement, stable process identity
and boot-lock creation gaps. They are covered by cgroup-v2 checks, five seconds
of pinned invocation health, proxy/redirect rejection, and a tmpfiles rule. A
final-probe restart race reproduced before the fix and is covered by the focused
regression. Actual builder sandbox and timer installation remain to be verified.
