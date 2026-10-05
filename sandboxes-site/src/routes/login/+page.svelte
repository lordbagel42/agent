<script lang="ts">
  import { ArrowRight, Box, LockKeyhole, ShieldCheck } from "@lucide/svelte";
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import type { PageProps } from "./$types";
  let { form }: PageProps = $props();
  let pending = $state(false);
</script>

<svelte:head><title>Sign in · June Sandboxes</title></svelte:head>
<div class="login-page">
  <header class="login-brand">
    <span class="brand-icon"><Box size={21} /></span><strong>June</strong><span
      class="brand-divider">/</span
    ><span>Sandboxes</span>
  </header>
  <main class="login-main">
    <div class="login-title-icon">
      <LockKeyhole size={23} strokeWidth={1.5} />
    </div>
    <h1>Your sandbox workspace.</h1>
    <p class="login-description">
      A closer look at June’s environments.<br />Private, read-only, and never
      in the way.
    </p>
    <form
      method="POST"
      use:enhance={() => {
        pending = true;
        return async ({ update }) => {
          await update();
          pending = false;
        };
      }}
    >
      <label for="key">Viewer key</label>
      <Input
        id="key"
        name="key"
        type="password"
        autocomplete="current-password"
        required
        maxlength={512}
        placeholder="Enter your private viewer key"
        class="h-11 rounded-md"
      />
      {#if form?.error}<p class="form-error" role="alert">{form.error}</p>{/if}
      <Button type="submit" disabled={pending} class="h-11 w-full rounded-md"
        >{pending ? "Signing in…" : "Open workspace"}<ArrowRight
          size={16}
        /></Button
      >
    </form>
    <p class="login-help">
      Use your June debug-site viewer key. Access expires after 8 hours; signing
      out revokes this session.
    </p>
  </main>
  <footer class="login-footer">
    <ShieldCheck size={15} />Owner-private access<span>June / BoxLite</span>
  </footer>
</div>
