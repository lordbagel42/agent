# WhatsApp Cloud API

June uses Meta's official Business Platform Cloud API for owner text and Unicode
reactions. This is a business phone number, not a QR bridge to a personal account.
The owner's verified Slack DMs and WhatsApp use the same private conversation;
replies go to the incoming destination. No additional enable flag is required:
installing valid `whatsapp` configuration and its credentials mounts the adapter.
An absent account leaves the integration unavailable, visible to June through
`inspection:"capability-matrix"`. That inspection never probes Meta or attests
live delivery.

## Enrollment and private configuration

1. In Meta's WhatsApp API setup, register/select the business phone number and
   record its **phone-number ID**, not the displayed telephone number or WABA ID.
   For Meta's test number, verify the owner's recipient number in the dashboard.
2. Provision the app secret, an access token authorized for that phone number,
   and a separately generated private webhook verification token through the
   host's existing secret mechanism. Do not paste tokens into chat, Git, URLs,
   shell arguments or logs. The verification token is not the app secret.
3. Merge this fragment into private configuration, preserving existing Slack
   identities and unrelated settings. The IDs below are illustrative, not live.
   `senderId` is the owner's WhatsApp international number as digits, without `+`.
   Pin a supported Graph API version; `v26.0` is the version checked in October 2026.

```json
{
  "owner": {
    "id": "raygen",
    "identities": [
      {
        "channel": "whatsapp",
        "accountId": "123456789012345",
        "senderId": "15551234567"
      }
    ]
  },
  "whatsapp": {
    "phoneNumberId": "123456789012345",
    "apiVersion": "v26.0",
    "appSecretEnv": "WHATSAPP_APP_SECRET",
    "verifyTokenEnv": "WHATSAPP_VERIFY_TOKEN",
    "accessTokenEnv": "WHATSAPP_ACCESS_TOKEN"
  }
}
```

Exactly one WhatsApp owner must match that phone-number ID. Other WhatsApp
senders are ignored. Missing configured credentials fail startup rather than
silently using another credential. Activity sessions require Slack-only owner
ingress and cannot be combined with WhatsApp; do not silently disable an active
session deployment to enroll this transport.

4. Install the narrow HTTPS ingress below and subscribe the Meta app's
   `whatsapp_business_account` **messages** webhooks to
   `https://june-whatsapp.raygen.dev/webhooks/whatsapp`, entering the same private
   verification token in Meta. GET challenge verification proves only the
   callback/token pair, not POST authentication, delivery or outbound access.
5. Send a fresh text from the allowlisted owner to the business number. Confirm
   one June reply on the handset and a recorded send outcome; replaying the same
   webhook ID must not produce another reply. Test a Unicode reaction, then a
   follow-up from Slack and back to verify private continuity. Only this live
   account exercise proves the provider connection; local fixtures do not.

June can inspect setup requirements and request missing enrollment/credentials
from Raygen privately. She must never ask for secret values in the conversation.
Provider consent and coordinated host credential installation remain operator
actions; no account-enrollment or secret-writing model tool is introduced.

## Blue/green ingress and deployment

The HAProxy 3.0+ templates
[`june-whatsapp-proxy.cfg`](../scripts/deploy/june-whatsapp-proxy.cfg) and
[`june-whatsapp-proxy.service`](../scripts/deploy/june-whatsapp-proxy.service)
follow the existing MCP proxy pattern. They accept only the exact hostname,
path and GET/POST methods on private LAN port 3086. Query parameters are allowed
for Meta's GET challenge. Nothing publishes `/health`, the console, or operator
routes. The proxy preserves bodies and signature headers, stores no credentials,
disables request logging/caching/retries, and forwards only when exactly one
loopback slot (3081/3082) reports HTTP 200 at `/health`.

Installation is a coordinated operator change, not a side effect of publishing
source. Follow [deployment ownership and binding migration](deployment.md):
acquire the host operator lock, settle the poller and any existing recovery owner,
and establish your own hold before changes. Preserve unrelated config and slot
environment values. New account/credential configuration changes the protected
runtime binding: prepare and activate a new forward release through the deployment
tooling, never rewrite an old release marker or restore old conversation data.

Install the config root-owned `0644` at
`/etc/june-whatsapp-proxy/haproxy.cfg` (directory `0755`) and the dedicated systemd
unit. Validate with `haproxy -c` before starting it. Use the existing installed
HAProxy; do not start an unrelated default listener. Route only the exact public
hostname/path/methods through the existing HTTPS tunnel/Traefik to
`192.168.0.215:3086`, preserving Host and query parameters. Keep query strings
(the GET token), signatures and bodies out of every upstream access log too.
Never expose either slot directly. Verify loaded revision, ready health and
settled intake/cutover before releasing only your hold and restoring the poller.

The application admits signed payloads up to 3 MB, verifies raw-byte HMAC-SHA256
with the app secret, filters the configured phone-number ID and owner identity,
and acknowledges only after accepted events are durably submitted. Duplicate
IDs are deduplicated by the existing conversation inbox. A partial batch retry
may contain events already accepted; those must not be reprocessed.

There is no second WhatsApp intake database. During drain/cutover, storage
failure, or a stale proxy health observation, ingress can return non-200. Meta
retries failed webhook delivery for up to seven days with backoff; outages longer
than that need account/operator investigation, not an assumed successful delivery.
The proxy does not retry or activate slots. Outbound Graph requests abort after
10 seconds but remain admitted until the underlying transport settles, so a
deployment cannot mistake a timed-out caller for a completed send. Other existing
unsupported drain integrations remain unsupported.

## Supported behavior and limits

- Text and reaction/removal webhooks; delivery/read/failure status receipts.
  Inbound images, files and voice are not fetched or passed to June.
- Outbound text up to 4096 Unicode code points, reply context and Unicode
  reactions. Existing artifact images use captions limited to 1024 characters.
  Each conversational `messages` part has its own durable delivery record;
  the adapter never silently splits one send into several effects.
- Free-form messages require an inbound owner text **less than 24 hours ago**.
  Reactions and status callbacks do not reopen that window. No proactive
  templates, group chats, history retrieval, typing indicators or arbitrary
  recipient messaging are implemented.
- HTTP 429 is explicitly retryable within the runtime's bounded retry policy.
  Other 4xx responses are rejected. Timeouts, network errors, 5xx and malformed
  successful responses are **unknown**, never automatically repeated. A missing
  reply is not proof no send occurred. Inspect receipts before recovery.

Before declaring enrollment complete, check invalid signature rejection,
non-owner/wrong-account filtering, replay deduplication, expired-window rejection,
one live inbound/outbound exchange, and blue/green drain/resume. Keep credentials,
phone IDs and private message content out of verification logs.

Meta references: [Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/),
[webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview),
[Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog/).
