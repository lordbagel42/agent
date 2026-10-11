/** Fixed controller reasons and their published explanations (`june/deploy` checks). */
export const REASONS: Readonly<Record<string, string>> = {
  preflight_failed:
    "Source preparation or preflight failed; individual command results are not recorded. Operator diagnosis required.",
  prior_release_invalid:
    "The previous release failed integrity verification. Operator repair required; the candidate is not failed.",
  binding_changed:
    "Protected runtime configuration or service binding changed. Operator reconciliation required; the candidate is not failed.",
  standby_unavailable:
    "Candidate standby could not be verified. Old June was not stopped; inspect retained slot identity before retrying.",
  intake_not_settled:
    "Intake pause did not settle. Admission was resumed if verified safe; inspect later block/retry evidence.",
  cutover_interrupted:
    "Cutover was interrupted. Only acknowledged pre-stop phases with unchanged process identity can resume automatically; unknown requests stay blocked.",
  lifecycle_failed:
    "The active runtime latched a lifecycle failure. Readiness and drain remain refused; recovery is attributed to the active revision, not a queued candidate.",
  actions_pending:
    "Waiting for the exact main revision's GitHub Actions build. June remains on the current release.",
  actions_unavailable:
    "Actions evidence or artifact download is unavailable. The controller will retry; no local-build fallback.",
  actions_build_failed:
    "The exact main revision's Actions build did not succeed. Publish a forward fix; this tool cannot retry it.",
  actions_artifact_invalid:
    "Actions provenance, artifact integrity or archive validation failed. Operator diagnosis required; not activated.",
  actions_policy_changed:
    "Actions build policy differs from the operator-reviewed versions. Review and update the protected policy pins, then publish a forward commit; not activated.",
  actions_build_ready:
    "The exact main revision's Actions build succeeded. Local artifact verification and activation gates are still required; this is not deployment success.",
  health_failed:
    "Candidate failed readiness or process-identity checks. Inspect later rollback/block events.",
  drain_busy:
    "In-flight work could not be safely drained. A deferred event uses bounded retries without cancelling work; a blocked event requires operator recovery for exhausted retries or uncertainty recorded by an older controller.",
  insufficient_disk:
    "Insufficient disk capacity. Operator must restore capacity; the controller will retry.",
  resume_failed: "Admission could not be resumed. Operator recovery required.",
  current_unhealthy:
    "Current service identity/readiness is unverified. Operator inspection required.",
  candidate_not_drained:
    "Failed candidate could not be safely drained. Operator recovery required; no forced restart.",
  unsafe_rollback:
    "Rollback compatibility is not established. Operator forward recovery required; never restore conversation data.",
  rollback_unhealthy:
    "Rollback did not establish a healthy service. Operator recovery required.",
  activation_unknown:
    "An activation may be incomplete. Operator must establish actual service state and reconcile; no automatic retry.",
  non_fast_forward:
    "Main moved backwards or diverged. Owner must resolve trusted branch history.",
  fetch_failed:
    "Controller could not observe trusted main. Inspect repository access.",
  controller_failed:
    "Controller failed outside a deployment stage. Inspect protected installation and service logs.",
  repository_metadata_failed:
    "Repository metadata publication failed. Inspect the controller without exposing Git output.",
  github_status_publish_failed:
    "GitHub deployment reporting failed. Inspect credentials and API access without exposing tokens.",
};

export const isReason = (value: string) => Object.hasOwn(REASONS, value);
