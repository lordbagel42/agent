<script lang="ts">
  import type { WebMessage } from "../../../contracts.js";
  import Icon from "./Icon.svelte";
  import { dateTime, time } from "./display.js";
  let { message }: { message: WebMessage } = $props();
  // Slack's three entities only. Svelte always escapes the result as text.
  const text = $derived(
    message.text.replace(/&(?:amp|lt|gt);/g, (value) =>
      value === "&amp;" ? "&" : value === "&lt;" ? "<" : ">",
    ),
  );
</script>

<article class="message">
  <div class:june={message.author.june} class="avatar" aria-hidden="true">
    {message.author.name.slice(0, 1).toUpperCase()}
  </div>
  <div class="message-body">
    <header class="message-meta">
      <strong>{message.author.name}</strong><span
        >{message.author.june ? "AI assistant" : "via Slack"}</span
      ><time title={dateTime(message.timestamp)}>{time(message.timestamp)}</time
      >{#if message.edited}<span>edited</span>{/if}
    </header>
    <p class="message-text">{text}</p>
    {#if message.truncated}<p class="hint">
        Message shortened. Open Slack for the full text.
      </p>{/if}
    {#each message.files as file (file.id)}
      <div class="file-row">
        <Icon name="file" size={22} />
        <div>
          <strong>{file.name}</strong><span>{file.type} · view in Slack</span>
        </div>
      </div>
    {/each}
    {#if message.replyCount > 0}<p class="hint">
        {message.replyCount} thread {message.replyCount === 1
          ? "reply"
          : "replies"} · open Slack to explore
      </p>{/if}
  </div>
</article>
