<script lang="ts">
  import { ArrowLeft, Fingerprint, Plus } from "@lucide/svelte";
  import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
  import type { ArchiveState } from "$lib/archive.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  let {
    state: view,
    onadd,
    onremove,
    onrefresh,
    onback,
  }: {
    state: ArchiveState;
    onadd: (name: string) => Promise<void>;
    onremove: (id: string) => Promise<void>;
    onrefresh: () => void;
    onback: () => void;
  } = $props();
  let name = $state("");
  let removing = $state<string | null>(null);
  const supportsPasskeys = browserSupportsWebAuthn();
  const date = (value: number) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await onadd(name.trim());
    if (view.passkeyNotice) name = "";
  }
</script>

<div class="passkeys-page">
  <Button variant="ghost" onclick={onback}
    ><ArrowLeft size={15} aria-hidden="true" />Back to archive</Button
  >
  <h1>Passkeys</h1>
  <p class="passkeys-intro">
    Sign in with your fingerprint, face, device PIN or security key. These
    passkeys unlock only June Debug, independently of June’s main console.
  </p>
  {#if view.passkeyError}<div class="action-error" role="alert">
      <p>{view.passkeyError}</p>
      {#if view.passkeys === null}<Button
          variant="outline"
          onclick={onrefresh}
          disabled={view.passkeyBusy}>Retry loading</Button
        >{/if}
    </div>{/if}
  {#if view.passkeyNotice}<p class="notice" role="status">
      {view.passkeyNotice}
    </p>{/if}
  <section aria-labelledby="saved-passkeys" class="passkeys-section">
    <h2 id="saved-passkeys">
      Your passkeys <span class="muted"
        >{view.passkeys === null ? "" : `· ${view.passkeys.length}`}</span
      >
    </h2>
    {#if view.passkeys === null && view.passkeyBusy}
      <p class="muted" role="status">Loading passkeys…</p>
    {:else if view.passkeys?.length === 0}
      <div class="passkey-empty">
        <Fingerprint size={22} aria-hidden="true" />
        <div>
          <h3>No passkeys yet</h3>
          <p>
            Add your first passkey below. Your viewer credential remains
            available for recovery.
          </p>
        </div>
      </div>
    {:else if view.passkeys}
      <ul class="passkey-list">
        {#each view.passkeys as key (key.id)}
          <li>
            <div class="passkey-row">
              <Fingerprint size={19} aria-hidden="true" />
              <div class="passkey-details">
                <h3>{key.name}</h3>
                <p>
                  Added {date(key.createdAt)}<br />{key.lastUsedAt === null
                    ? "Not used to sign in yet"
                    : `Last used ${date(key.lastUsedAt)}`}
                </p>
              </div>
              <Button
                variant="outline"
                disabled={view.passkeyBusy}
                aria-label={`Remove ${key.name}`}
                aria-expanded={removing === key.id}
                onclick={() => (removing = removing === key.id ? null : key.id)}
                >Remove</Button
              >
            </div>
            {#if removing === key.id}<div class="passkey-confirm">
                <p>
                  Remove <strong>{key.name}</strong>? All devices will be signed
                  out. {view.passkeys.length === 1
                    ? "This is your last passkey. You’ll need the viewer credential to sign in again."
                    : "You can sign back in with a remaining passkey or your viewer credential."}
                </p>
                <div class="inline-actions">
                  <Button
                    variant="destructive"
                    disabled={view.passkeyBusy}
                    onclick={() => onremove(key.id)}
                    >Remove and sign out all devices</Button
                  ><Button
                    variant="ghost"
                    disabled={view.passkeyBusy}
                    onclick={() => (removing = null)}>Cancel</Button
                  >
                </div>
              </div>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
  <section aria-labelledby="add-passkey" class="passkeys-section">
    <h2 id="add-passkey">Add a passkey</h2>
    <p class="field-hint">
      Adding or removing a passkey requires a sign-in within the last five
      minutes.
    </p>
    <form class="passkey-form" onsubmit={submit}>
      <Label for="passkey-name">Passkey name</Label>
      <div class="passkey-add-row">
        <Input
          id="passkey-name"
          bind:value={name}
          placeholder="e.g. Phone or password manager"
          autocomplete="off"
          maxlength={80}
          required
          disabled={view.passkeyBusy || !supportsPasskeys}
          aria-describedby="passkey-hint"
        />
        <Button
          type="submit"
          disabled={view.passkeyBusy ||
            !supportsPasskeys ||
            !name.trim() ||
            (view.passkeys?.length ?? 0) >= 16}
          ><Plus size={15} aria-hidden="true" />Add passkey</Button
        >
      </div>
      <p id="passkey-hint" class="field-hint">
        {supportsPasskeys
          ? "Your device or password manager keeps the private key. June Debug stores only the public key."
          : "This browser does not support passkeys. Use a current browser over HTTPS to add one."}
      </p>
      {#if view.passkeyBusy && view.passkeys !== null}<p
          class="field-hint"
          role="status"
        >
          Completing request. Check your browser or device prompt.
        </p>{/if}
    </form>
  </section>
  <p class="passkey-recovery field-hint">
    Keep your viewer credential somewhere safe. If you lose access to every
    passkey, use it to sign in and remove the lost keys. Removing a passkey here
    does not delete it from your password manager.
  </p>
</div>
