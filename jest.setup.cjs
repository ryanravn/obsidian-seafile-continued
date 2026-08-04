// Obsidian runs plugins in an Electron renderer, where browser timers and
// Electron's CommonJS loader live on window. Mirror that minimal surface in
// Jest's Node environment without changing production code paths.
globalThis.window = globalThis;
globalThis.window.require = require;
