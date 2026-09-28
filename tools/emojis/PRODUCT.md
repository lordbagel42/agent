# Emoji search

## Platform
Web dashboard and agent API; portable Node indexing daemon.

## Users and purpose
Raygen monitors indexing; June and other authenticated agents find appropriate
Hack Club Slack emoji by appearance, emotion, action and meaning.

## Approved constraints
Cloudflare Worker deployment at emojis.raygen.dev. Codex describes emoji on
LEGION initially, moving to the homelab later. Target up to 1,000 simultaneous
descriptions with a measured safe ramp. Search targets approximately 200 ms;
no measured performance claim exists yet. Authentication is required. Aliases,
animations and uncertain interpretations must be handled explicitly.

## Dashboard scope
Show actual progress, rate, resource pressure, failures and recent descriptions.
No invented statistics. Local preview is read-only. Plain static HTML/CSS/JS is
an implementation choice to share the surface between Node and Workers.
