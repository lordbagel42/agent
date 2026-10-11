function date(timestamp: string) {
  // Numeric conversion is for display only; IDs remain the original strings.
  const value = new Date(Number(timestamp.split(".")[0]) * 1000);
  return Number.isFinite(value.getTime()) ? value : null;
}

export const time = (timestamp: string) =>
  date(timestamp)?.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  }) ?? timestamp;
export const dateTime = (timestamp: string) =>
  date(timestamp)?.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  }) ?? timestamp;
export const day = (timestamp: string) =>
  date(timestamp)?.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  }) ?? timestamp;

export const failureMessage = (code: string) =>
  ({
    access_denied:
      "This conversation is no longer available to your account. Your Slack membership may have changed.",
    missing_scope:
      "June’s Slack installation cannot read this view. Ask the app owner to review its existing permissions; no permissions were changed.",
    rate_limited:
      "Slack asked June to slow down. Wait before refreshing; no automatic retries are running.",
    busy: "Another conversation read is finishing. Try again in a moment.",
    slack_not_configured:
      "Slack is not configured on this June host. Ask June to inspect the Slack setup before using this view.",
    invalid_request:
      "This conversation link is not valid. Choose a conversation from the list.",
  })[code] ??
  "June could not read this view. Check your connection and refresh, or continue in Slack. No messages were sent.";
