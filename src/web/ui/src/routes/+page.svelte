<script lang="ts">
  import { onMount } from "svelte";
  import type {
    WebConversation,
    WebConversationList,
    WebTranscript,
  } from "../../../contracts.js";
  import Icon from "$lib/Icon.svelte";
  import Message from "$lib/Message.svelte";
  import { day, failureMessage } from "$lib/display.js";

  let conversations = $state<WebConversation[]>([]);
  let transcript = $state<WebTranscript | null>(null);
  let selected = $state<WebConversation | null>(null);
  let next = $state<number | null>(null);
  let listPage = $state<number | null>(null);
  let messagePage = $state<string | null>(null);
  let loadingList = $state(true);
  let loadingThread = $state(false);
  let listError = $state("");
  let threadError = $state("");
  let expired = $state(false);
  let filter = $state("");
  let listLimited = $state(false);
  let details = $state(true);
  let mobileView = $state<"list" | "thread" | "details">("list");
  let retryAt = $state(0);
  let now = $state(Date.now());
  let sequence = 0;
  let controller: AbortController | undefined;
  const busy = $derived(loadingList || loadingThread);
  const waiting = $derived(Math.max(0, Math.ceil((retryAt - now) / 1000)));
  const filtered = $derived(
    conversations.filter((item) =>
      `${item.name} ${item.audience} ${item.thread ?? ""}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ),
  );
  const participants = $derived([
    ...new Map(
      (transcript?.messages ?? []).map((message) => [
        message.author.id,
        message.author,
      ]),
    ).values(),
  ]);
  const files = $derived([
    ...new Map(
      (transcript?.messages ?? [])
        .flatMap((message) => message.files)
        .map((file) => [file.id, file]),
    ).values(),
  ]);

  function clear() {
    sequence++;
    controller?.abort();
    conversations = [];
    transcript = null;
    selected = null;
    next = null;
    listPage = null;
    messagePage = null;
    mobileView = "list";
    loadingThread = false;
    loadingList = false;
  }

  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/app/api/${path}`, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 401) {
      clear();
      expired = true;
      throw new Error("session_expired");
    }
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: "unavailable" }));
      const seconds = Number(response.headers.get("retry-after"));
      if (seconds > 0) retryAt = Date.now() + seconds * 1000;
      throw new Error(body.error ?? "unavailable");
    }
    return response.json();
  }

  async function open(
    conversation: WebConversation,
    cursor: string | null = null,
  ) {
    controller?.abort();
    controller = new AbortController();
    const request = ++sequence;
    selected = conversation;
    messagePage = cursor;
    transcript = null;
    threadError = "";
    loadingThread = true;
    mobileView = "thread";
    history.replaceState(
      null,
      "",
      `/app#${encodeURIComponent(conversation.id)}`,
    );
    const query = new URLSearchParams({ channel: conversation.channel });
    if (conversation.thread) query.set("thread", conversation.thread);
    if (cursor) query.set("cursor", cursor);
    try {
      const result = await get<WebTranscript>(
        `transcript?${query}`,
        controller.signal,
      );
      if (sequence === request) transcript = result;
    } catch (error) {
      if (sequence === request) {
        const code = error instanceof Error ? error.message : "unavailable";
        threadError = failureMessage(code);
        if (code === "access_denied") {
          conversations = conversations.filter(
            (item) => item.channel !== conversation.channel,
          );
          selected = null;
        }
      }
    } finally {
      if (sequence === request) loadingThread = false;
    }
  }

  async function loadList(before: number | null = null) {
    const previous = selected?.id;
    clear();
    listPage = before;
    loadingList = true;
    listError = "";
    const request = sequence;
    controller = new AbortController();
    try {
      const result = await get<WebConversationList>(
        `conversations${before ? `?before=${before}` : ""}`,
        controller.signal,
      );
      if (sequence !== request) return;
      conversations = result.conversations;
      next = result.next;
      listLimited = result.limited;
      loadingList = false;
      // Deep links select only conversations returned by this authorized page.
      let requested = previous;
      if (!requested) {
        try {
          requested = decodeURIComponent(location.hash.slice(1));
        } catch {
          // A malformed fragment is not a failed Slack read.
        }
      }
      const choice =
        conversations.find((item) => item.id === requested) ??
        (before === null ? conversations[0] : undefined);
      if (choice) await open(choice);
    } catch (error) {
      if (sequence === request)
        listError = failureMessage(
          error instanceof Error ? error.message : "unavailable",
        );
    } finally {
      if (sequence === request) loadingList = false;
    }
  }

  onMount(() => {
    void loadList();
    const clock = setInterval(() => {
      now = Date.now();
    }, 1000);
    // Session checks have no Slack calls. Hidden pages retain no transcript, and
    // re-enter through fresh authorization, not browser storage or a stale cache.
    const session = setInterval(() => {
      if (!expired && document.visibilityState === "visible")
        void get("status").catch(() => {
          clear();
          listError =
            "Session could not be checked. Refresh when you are connected again.";
          mobileView = "list";
        });
    }, 30_000);
    const visibility = () => {
      if (document.visibilityState === "hidden") clear();
      else if (!expired) void loadList();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clear();
      clearInterval(clock);
      clearInterval(session);
      document.removeEventListener("visibilitychange", visibility);
    };
  });
</script>

<svelte:head
  ><title>Conversations · June</title><meta
    name="description"
    content="Your conversations with June, with private and shared Slack scopes kept separate."
  /></svelte:head
>

<a class="skip" href="#conversation">Skip to conversation</a>
<header class="topbar">
  <a class="brand" href="/app"><span class="brand-mark">J</span>June</a>
  <span class="app-name">Conversations</span>
  <div class="account">
    <span class="owner"><Icon name="lock" size={14} />Owner only</span><a
      href="/console">Dashboard</a
    ><a href="/console/session/logout">Sign out</a>
  </div>
</header>

{#if expired}
  <main class="session-state">
    <Icon name="lock" size={28} />
    <h1>Your session has ended</h1>
    <p>
      Conversation content has been cleared. Sign in again to check your current
      access.
    </p>
    <a class="button primary" href="/console/session/login?returnTo=/app"
      >Sign in to June</a
    >
  </main>
{:else}
  <div
    class="workspace"
    class:with-details={details && !!transcript}
    data-view={mobileView}
  >
    <aside class="sidebar" aria-label="Conversations">
      <div class="sidebar-heading">
        <h1>Conversations</h1>
        <button
          class="icon-button"
          aria-label="Refresh conversations"
          disabled={busy || waiting > 0}
          onclick={() => loadList()}><Icon name="refresh" /></button
        >
      </div>
      <label class="search"
        ><Icon name="search" size={16} /><input
          aria-label="Filter conversations"
          placeholder="Find a conversation"
          bind:value={filter}
        /></label
      >
      <div class="conversation-list" aria-busy={loadingList}>
        {#if loadingList}<p class="list-state" role="status">
            Reading your conversations…
          </p>
        {:else if listError}<div class="list-state error" role="alert">
            <p>{listError}</p>
            <button
              disabled={busy || waiting > 0}
              onclick={() => loadList(listPage)}>Try again</button
            >
          </div>
        {:else}
          {#each ["private", "shared"] as scope}
            <section class="conversation-group">
              <h2>{scope === "private" ? "Private" : "Slack threads"}</h2>
              {#each filtered.filter((item) => item.scope === scope) as conversation (conversation.id)}
                <button
                  class="conversation-row"
                  class:selected={selected?.id === conversation.id}
                  aria-current={selected?.id === conversation.id
                    ? "page"
                    : undefined}
                  disabled={busy || waiting > 0}
                  onclick={() => open(conversation)}
                >
                  <span class="row-icon"
                    ><Icon name={scope === "private" ? "lock" : "hash"} /></span
                  ><span class="row-copy"
                    ><strong>{conversation.name}</strong><span
                      >{conversation.thread
                        ? `Thread · ${day(conversation.thread)}`
                        : "Your private Slack conversation"}</span
                    ></span
                  >
                </button>
              {:else}<p class="group-empty">
                  {filter
                    ? "No matches in this scope."
                    : scope === "private"
                      ? "No private DM found in this page."
                      : "No accessible threads in this page."}
                </p>{/each}
            </section>
          {/each}
          {#if next}<button
              class="more-conversations"
              disabled={busy || waiting > 0}
              onclick={() => loadList(next)}>Older conversations</button
            >{/if}
          {#if listLimited}<p class="list-state">
              Discovery is limited. Some conversations may not appear.
            </p>{/if}
        {/if}
      </div>
      <footer class="sidebar-footer">
        <Icon name="lock" size={14} />
        <p>
          Only you can open this app.<br />Shared threads keep their Slack
          audience.
        </p>
      </footer>
    </aside>

    <main
      id="conversation"
      class="conversation"
      tabindex="-1"
      aria-busy={loadingThread}
    >
      <header class="conversation-heading">
        <button
          class="icon-button mobile-only"
          aria-label="Back to conversations"
          onclick={() => {
            mobileView = "list";
          }}><Icon name="back" /></button
        >
        <div class="heading-copy">
          <h2>{selected?.name ?? "Your conversations with June"}</h2>
          <p>
            {selected
              ? `${selected.thread ? "Slack thread" : "Slack direct message"} · ${selected.team}`
              : "Private when it should be. Shared where it belongs."}
          </p>
        </div>
        {#if selected}<button
            class="icon-button"
            aria-label="Refresh messages"
            disabled={busy || waiting > 0}
            onclick={() => selected && open(selected)}
            ><Icon name="refresh" /></button
          >{/if}
        {#if transcript}<button
            class="icon-button"
            aria-label="Conversation details"
            aria-expanded={details}
            onclick={() => {
              if (matchMedia("(max-width: 760px)").matches) {
                details = true;
                mobileView = "details";
              } else {
                details = !details;
              }
            }}><Icon name="panel" /></button
          >{/if}
      </header>
      {#if selected}<div class="scope-bar">
          <Icon
            name={selected.scope === "private" ? "lock" : "users"}
            size={15}
          /><strong
            >{selected.scope === "private" ? "Private" : "Shared"}</strong
          ><span>{selected.audience}</span>
        </div>{/if}
      {#if waiting > 0}<p class="notice" role="status">
          Refresh available in {waiting}s.
        </p>{/if}
      <div class="timeline">
        {#if loadingThread}<div class="blank-state" role="status">
            <Icon name="chat" size={28} />
            <h3>Reading this conversation…</h3>
            <p>Checking your current Slack access.</p>
          </div>
        {:else if threadError}<div class="blank-state error" role="alert">
            <h3>Conversation unavailable</h3>
            <p>{threadError}</p>
            {#if selected}<button
                disabled={busy || waiting > 0}
                onclick={() => selected && open(selected, messagePage)}
                >Try again</button
              >{/if}
          </div>
        {:else if transcript}
          <div class="history-note">
            <span>Read from Slack</span><span
              >{new Date(transcript.observedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })} · your local time</span
            >
          </div>
          {#each transcript.messages as message, index (message.id)}
            {#if index === 0 || day(message.timestamp) !== day(transcript.messages[index - 1].timestamp)}<div
                class="day-divider"
              >
                <span>{day(message.timestamp)}</span>
              </div>{/if}
            <Message {message} />
          {:else}<div class="blank-state">
              <Icon name="chat" size={28} />
              <h3>No readable messages in this page</h3>
              <p>
                Slack may have removed or retained only part of this
                conversation.
              </p>
            </div>{/each}
          <div class="coverage">
            <p>
              {transcript.limited
                ? "Slack reports retention-limited history. "
                : ""}Available plain text only, up to 15 messages per page.
              Deleted messages and file contents are not recovered.
            </p>
            {#if transcript.next}<button
                disabled={busy || waiting > 0}
                onclick={() =>
                  selected && open(selected, transcript?.next ?? null)}
                >{selected?.thread
                  ? "Next message page"
                  : "Older message page"}</button
              >{:else if transcript.more}<p>
                Slack reports more messages but supplied no continuation. Open
                Slack for more context.
              </p>{/if}
          </div>
        {:else}<div class="blank-state">
            <Icon name="chat" size={32} />
            <h3>A place to follow the conversation</h3>
            <p>
              Choose a private DM or a Slack thread. Everyone’s words stay
              attributed, and shared work stays separate from your private
              conversation.
            </p>
          </div>{/if}
      </div>
      {#if selected}<footer class="reply-destination">
          <div>
            <strong
              >{selected.scope === "private"
                ? "Continue privately with June"
                : `Reply in ${selected.name}`}</strong
            >
            <p>
              This version is read-only. Your reply belongs in {selected.thread
                ? "the same Slack thread"
                : "your Slack DM"}.
            </p>
          </div>
          <a
            class="button primary"
            href={selected.slackUrl}
            target="_blank"
            rel="noopener noreferrer"
            >Open in Slack<Icon name="arrow" size={16} /></a
          >
        </footer>{/if}
    </main>

    {#if transcript}
      <aside
        class="details"
        class:closed={!details}
        aria-label="Conversation details"
      >
        <header>
          <h2>Conversation details</h2>
          <button
            class="icon-button"
            aria-label="Close details"
            onclick={() => {
              details = false;
              mobileView = "thread";
            }}><Icon name="close" size={17} /></button
          >
        </header>
        <section>
          <h3>Audience</h3>
          <p class="audience">
            <Icon
              name={transcript.conversation.scope === "private"
                ? "lock"
                : "users"}
            />{transcript.conversation.audience}
          </p>
          <p class="hint">
            App access is owner-only. Reading here does not change who can read
            the original conversation.
          </p>
        </section>
        <section>
          <h3>People in this page <span>{participants.length}</span></h3>
          <ul class="people">
            {#each participants as person (person.id)}<li>
                <span
                  class="avatar small"
                  class:june={person.june}
                  aria-hidden="true"
                  >{person.name.slice(0, 1).toUpperCase()}</span
                >
                <div>
                  <strong>{person.name}</strong><span
                    >{person.june ? "AI assistant · Slack" : "via Slack"}</span
                  >
                </div>
              </li>{/each}
          </ul>
          <p class="hint">
            Authors shown here, not a complete channel membership list.
          </p>
        </section>
        <section>
          <h3>Files in this page <span>{files.length}</span></h3>
          {#each files as file (file.id)}<div class="file-row">
              <Icon name="file" size={20} />
              <div><strong>{file.name}</strong><span>{file.type}</span></div>
            </div>{:else}<p class="hint">
              No file metadata in these messages.
            </p>{/each}{#if files.length}<p class="hint">
              Open the conversation in Slack to access files under their
              original permissions.
            </p>{/if}
        </section>
        <section>
          <h3>Separate by design</h3>
          <p class="hint">
            Private memory, worker activity and operator controls are not part
            of this transcript. Refresh reads Slack again; it never starts work
            or sends messages.
          </p>
        </section>
      </aside>
    {/if}
  </div>
{/if}
