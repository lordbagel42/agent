// Loaded as a classic script before the client module. Excalidraw creates its
// font faces while its code-split chunk evaluates, ahead of any statement in
// client.tsx; without this they load from esm.sh, which the CSP blocks.
Object.assign(window, { EXCALIDRAW_ASSET_PATH: "/artifacts/assets/" });
