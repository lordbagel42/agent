# June

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

June's owner uses the private dashboard to inspect her work, connect accounts,
review permissions, and understand usage. It is a control panel, not a chat UI.

## Product Purpose

Make June's actual state and available actions understandable without redundant
authentication or confirmation steps. The owner approved this direction on
2026-09-28.

## Operating Context

June runs headlessly. The owner can ask her for a short-lived dashboard sign-in
link in a private conversation. Provider OAuth begins from Connections and
returns to the dashboard. The dashboard must work on desktop and mobile.

## Capabilities and Constraints

- Keep server-rendered Hono HTML and existing host APIs; do not add a SPA stack.
- Preserve private ingress, owner authorization, CSRF protection, single-use
  links, provider state validation, and separation of account authorization from
  tool permissions.
- Ordinary link previews must not redeem sign-in links. OAuth completion should
  not ask for consent a second time after the provider has obtained it.
- Tool permissions start disabled; destructive and permission-changing actions
  still require deliberate review. Unknown outcomes must not be silently retried.
- Report missing or stale state honestly. Saved credentials do not prove health.
- No third-party UI assets, live credential fixtures, or public admin previews.

## Product Principles

- Organize around tasks rather than implementation subsystems.
- Automate mechanical continuation, not meaningful consent.
- Make errors recoverable without asking the owner to understand internals.
- Keep state and next actions readable, accessible, and consistent.

## Brand Commitments

June remains a private, restrained operational interface. Familiar navigation,
clear typography and responsive behavior take precedence over decorative effects.
