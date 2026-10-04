<script lang="ts">
  import { LockKeyhole } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  let {
    busy,
    error,
    notice,
    signoutError,
    onlogin,
    onlogout,
  }: {
    busy: boolean;
    error: string;
    notice: string;
    signoutError: string;
    onlogin: (token: string) => void;
    onlogout: () => void;
  } = $props();
  let token = $state("");
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
      Use the credential for this archive, not June’s upload credential. It is
      never saved in browser storage or the URL.
    </p>
    {#if error}<p id="login-error" class="action-error" role="alert">
        {error}
      </p>{/if}
    <Button type="submit" disabled={busy || !token.trim()}
      >{busy ? "Signing in…" : "Sign in"}</Button
    >
  </form>
  <p class="login-footer">
    This separate archive does not sign you in to June’s main console.
  </p>
</div>
