<script lang="ts">
  let {
    name,
    size = 18,
  }: {
    name:
      | "lock"
      | "hash"
      | "arrow"
      | "back"
      | "search"
      | "refresh"
      | "panel"
      | "file"
      | "close"
      | "chat"
      | "users";
    size?: number;
  } = $props();
  const paths = {
    lock: "M6 10V7a6 6 0 0 1 12 0v3M5 10h14v12H5zM12 15v3",
    hash: "M9 3 7 21M17 3l-2 18M3 9h18M2 15h18",
    arrow: "M7 17 19 5M7 5h12v12M5 10H3v11h11v-2",
    back: "m14 5-7 7 7 7M7 12h14",
    search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    refresh: "M20 7a9 9 0 1 0 1 9M20 2v5h-5",
    panel: "M3 4h18v16H3zM15 4v16",
    file: "M14 2H5v20h14V7zM14 2v6h5M8 13h8M8 17h6",
    close: "m6 6 12 12M6 18 18 6",
    chat: "M3 3h18v14H9l-6 4zM7 8h10M7 12h7",
    users:
      "M15 21v-3a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v3M16 3a4 4 0 0 1 0 8M21 21v-3a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name]} /></svg
>
