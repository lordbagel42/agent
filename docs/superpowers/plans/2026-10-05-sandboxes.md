# Sandbox dashboard implementation plan

**Goal:** Deploy a private E2B-inspired SvelteKit and shadcn-svelte dashboard at sandboxes.raygen.dev.

**Architecture:** June remains the only BoxLite owner. An allowlisted read-only projection serves both June's existing private inspection action and a narrowly authenticated HTTP endpoint. A separately deployed SvelteKit Node service owns browser authentication and consumes that endpoint; it never opens VM storage or calls the SDK.

**Design:** E2B's dense inventory, narrow sidebar, dark neutral surfaces, orange active navigation, compact metadata and underlined detail tabs. No imitation metrics, terminal, filesystem or lifecycle controls. Unknown, disabled, disconnected and empty are distinct states. Mobile uses a compact navigation bar and contained table scrolling.

**Constraints:** Preserve existing ownership, cleanup and crash fences. No command bodies/output, actor keys, host paths, credentials or arbitrary provider errors in the projection. SDK metrics can boot stopped boxes and must not be called. Activity is bounded, metadata-only and explicitly process-local. BoxLite activation itself requires a separately verified KVM/cgroup host; the current host lacks KVM.

- [x] Add focused failing checks for observational reads, secret exclusion, lease/failure states, narrow credential separation and June-callable inspection.
- [x] Implement safe provider inventory, bounded service activity, inspection dispatch and shared runtime knowledge. Run format/lint/typecheck and focused tests; obtain Oracle review; publish an atomic backend increment.
- [x] Build SvelteKit with adapter-node and real shadcn-svelte primitives. Add private same-origin browser sessions, bounded upstream fetches, inventory/search/state filters, detail/activity and runtime views. Verify signed-out, populated, empty, disabled, filtered, error, expired-session and mobile states using synthetic fixtures.
- [ ] Review security and actual rendered screenshots, fix findings, format/lint/typecheck/build, and publish the UI increment.
- [ ] Install the independent service, least-privilege read credential, HTTPS/DNS route under coordinated operator ownership. Verify loaded revisions, unauthenticated denial, fresh login and the actual live snapshot. Leave the site running and document access and observed limitations.
