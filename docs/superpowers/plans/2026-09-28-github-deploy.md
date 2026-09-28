# GitHub App deployment implementation plan

**Goal:** App-owned deployment reports with working Details links and signed event wakeups in addition to polling.

**Approved design:** https://ampcode.com/threads/T-01a0e9f2-f47f-75b8-bc20-949666b8a873

**Architecture:** The protected Python controller remains the sole deployment authority. An independent signed webhook inbox persists and forwards events to June, and wakes the controller to fetch trusted main. Webhook receipt is not deployment admission. The controller publishes its existing durable admission before preparation begins.

## Constraints

- No personal-token fallback or payload-authorized deployment.
- Preserve activation locks, ancestry checks, recovery ownership and uncertain-effect protections.
- Raw webhook bodies remain private, bounded, and are erased after June accepts them.
- Source publication is distinct from protected controller installation and live verification.
- Use existing tests; add only security/deduplication coverage for the new ingress boundary.

## Execution

- [x] In `scripts/deploy/deploy.py`, share installation authentication between reporting, Actions downloads and HTTPS Git fetch. Scope each token to its own required permissions. Remove PAT/status-only mode.
- [x] Set each native check's `details_url` to its validated GitHub `html_url`; recover checks only from the configured App. Migrate retained legacy links with App credentials.
- [x] Publish `received` after durable queue admission and before preparation. Keep the existing read-only release inspection contract.
- [x] Add independent `github_intake.py` and its service: verify HMAC before JSON, retain delivery IDs/digests, cap storage, forward originals with retry, wake through a private Unix datagram socket. All wakes still fetch trusted main; polling repairs missed wakes.
- [x] Update deployment/GitHub docs and June's shared runtime knowledge. Verify knowledge reaches all prompt paths.
- [x] Run Python controller/ingress fixtures, Ruff formatting/lint, Biome formatting/lint and TypeScript checks. Obtain required expert review and resolve findings before publication.
- [ ] Coordinate homelab operator ownership, provision/install exact reviewed bytes, configure App/webhook routing and verify App attribution, nonempty useful Details, event receipts, polling and readiness. Report any remaining credential or activation blocker explicitly.
