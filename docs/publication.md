# Before making the repository public

The publication-preparation pass sanitized the current source and documentation,
not the repository's historical objects or hosting metadata. **Do not treat this
document as clearance to change repository visibility.**

## Audit scope and findings

The local audit examined 188 refs, 316 reachable commits and 1,850 unique blobs,
including 311 commits reachable from the locally available `origin/main`.
Credential-format, assignment, entropy and private-identifier checks found no
convincing live credential. This was an offline heuristic review, not proof that
no secret exists. It did not validate credentials against providers.

An additional Gitleaks v8.24.3 scan covered reachable Git diffs (`--all`, reporting
313 scanned commits) and the prepared 282-file source snapshot. Its two historical
findings and one current-tree finding refer to the same synthetic idempotency-key
UUID in an HTTP authorization test, not an authentication credential. No scanner
allowlist was added. The blob audit above also covered content beyond Git diffs;
neither check replaces review of hosting metadata and the final release revision.

Confirmed historical disclosures include personal/workspace Slack identifiers,
deployment hosts and network topology, local account paths, private coordination
links, and author/committer identities. Hundreds of commit messages also contain
private thread URLs. Cleaning current files does not remove these objects.

The owner explicitly accepts Slack IDs, Amp thread links, deployment domains,
private LAN addresses and infrastructure layout, local account/filesystem paths,
and commit author names/emails in the published history. Those findings are not
publication blockers and do not justify rewriting commits. This acceptance does
not extend to credentials or private conversation contents; any linked content's
visibility requires its own review.

No obvious tracked database, binary attachment or conversation export was found.
Unfetched refs, reflog-only or dangling objects, Git LFS payloads, ignored runtime
files, and GitHub-side issues, pull requests, Actions logs, releases and artifacts
were outside this scan. Remote freshness could not be verified because the local
GitHub authentication was unavailable.

## Preserve the real history

The owner's preference is to retain as much original history as possible. Keep
existing commits unchanged unless a specific unacceptable disclosure requires
removal. Do not replace the history with a fresh snapshot or strip Slack IDs and
Amp links merely to make an automated privacy report empty.

The historical metadata findings above are accepted. No confirmed live credential
was found in the completed local scans, so there is currently no identified
finding requiring a history rewrite. Preserve the full existing history, subject
to reviewing the latest remote revision and hosting artifacts still outside the
completed audit.

If a genuine secret or other unacceptable disclosure is found, scope remediation
to that finding and retain unaffected ancestry where possible. Changing an old
commit changes all descendant commit IDs, even when their content is unchanged.
Rewriting published history requires an explicit coordinated decision and cannot
erase copies, caches, forks or already published artifacts. No history has been
rewritten by this preparation pass.

## Final release checklist

- [ ] Reconcile the prepared changes with the current remote source and rerun
  checks on the exact revision intended for release.
- [ ] Run a maintained secret scanner against the publication tree and any history
  being released. Review findings manually; test fixtures can look like secrets,
  while real account identifiers may not look like credentials.
- [x] Owner accepts historical Slack IDs, Amp links, infrastructure details,
  local paths and commit attribution. Preserve them; do not treat them as secrets.
- [ ] Review GitHub issues, PRs, Actions logs/artifacts, releases, branches, tags,
  screenshots and linked files separately before any visibility change.
- [ ] Keep runtime credentials, conversation/memory stores, backups, provider
  homes, browser profiles and logs outside the published repository.
- [ ] If a real credential is discovered, revoke or rotate it through its provider
  before release. Deleting the file or rewriting history is not revocation.
- [ ] Choose a license deliberately and check dependency/source attribution.
  No license was selected during this privacy pass; public source without a
  license is not an open-source grant.
- [ ] Authorize the actual publication separately. A local audit does not change
  repository visibility or deploy an application.

## Existing installation compatibility

Slack ownership now comes from trusted `owner.identities`, not a personal ID
embedded in the source. Before deploying these changes, verify there is exactly
one Slack owner identity and that its account matches `slack.teamId`. Do not
change owner identity on a retained instance as a shortcut for transferring it:
persisted history, grants and pending work require a separate migration review.

Owner-specific wording and public project attribution remain intentional. This
pass removes private identifiers and infrastructure details; it does not turn
June into a configurable product for arbitrary users.
