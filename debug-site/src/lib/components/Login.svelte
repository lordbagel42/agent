<script lang="ts">
  import { Fingerprint, LockKeyhole } from "@lucide/svelte";
  import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  let {
    busy,
    error,
    notice,
    signoutError,
    onlogin,
    onpasskey,
    onlogout,
  }: {
    busy: boolean;
    error: string;
    notice: string;
    signoutError: string;
    onlogin: (token: string) => void;
    onpasskey: () => void;
    onlogout: () => void;
  } = $props();
  let token = $state("");
  const supportsPasskeys = browserSupportsWebAuthn();
  function submit(event: SubmitEvent) {
    event.preventDefault();
    const credential = token;
    token = "";
    onlogin(credential);
  }
</script>

<div class="login-shell">
  <LockKeyhole size={22} aria-hidden="true" />
  <h1>Sign in to June Debug</h1>
  <p>Inspect private diagnostic captures, even when June is offline.</p>
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if signoutError}<div class="notice" role="alert">
      <p>{signoutError}</p>
      <Button variant="outline" onclick={onlogout}>Retry sign out</Button>
    </div>{/if}
  {#if error}<p id="login-error" class="action-error" role="alert">
      {error}
    </p>{/if}
  <Button
    class="passkey-signin"
    onclick={onpasskey}
    disabled={busy || !supportsPasskeys}
  >
    <Fingerprint size={17} aria-hidden="true" />Sign in with passkey
  </Button>
  {#if busy}<p class="field-hint" role="status">
      Completing sign-in. Check your browser or device prompt.
    </p>{/if}
  {#if !supportsPasskeys}<p class="field-hint">
      This browser does not support passkeys. Use your viewer credential below.
    </p>{/if}
  <div class="login-divider"><span>First visit or recovery</span></div>
  <form onsubmit={submit} class="login-form">
    <Label for="viewer-token">Viewer credential</Label>
    <Input
      id="viewer-token"
      type="password"
      bind:value={token}
      autocomplete="off"
      spellcheck="false"
      required
      disabled={busy}
      aria-invalid={!!error}
      aria-describedby={error ? "login-error" : "login-hint"}
    />
    <p id="login-hint" class="field-hint">
      Sign in once with your viewer credential, then add a passkey. Keep the
      credential for recovery; never use June’s upload credential here.
    </p>
    <Button variant="outline" type="submit" disabled={busy || !token.trim()}
      >Sign in with credential</Button
    >
  </form>
  <p class="login-footer">
    This separate archive does not sign you in to June’s main console.
  </p>
</div>
