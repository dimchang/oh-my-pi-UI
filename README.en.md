# OMP Codex (omp-gui)

English | [中文 README](./README.md)

A Windows desktop GUI for [oh-my-pi](https://github.com/...) (omp), inspired by Codex-style interaction. It talks to an omp child process via NDJSON over stdio using `omp --mode rpc-ui`.

> This project is a **GUI shell**; the real agent engine comes from [oh-my-pi](https://github.com/...) (omp). The app does not bundle the omp binary, so omp must already be installed on your system.

![OMP-UI main interface](./assets/screenshot.png)

## Features

- **Multi-session sidebar / workspaces**: each session runs in its own omp process, so switching sessions does not interrupt ongoing generation; sessions are grouped by directory and can be archived or restored
- **File-edit tracking**: shows which files the agent is editing, completion status, token usage, and elapsed time in real time
- **Model configuration panel**: reads/writes omp `models.yml`, with support for adding/editing models, API key management, and an enabled-model whitelist
- **Permission mode & thinking level**: quickly toggle permission policies (e.g., YOLO) and the model thinking level (low / medium / high)
- **Steer mid-run correction**: send a new instruction while the agent is still executing to redirect or correct its course without waiting for the turn to finish
- **Minimap density scrollbar**: a 14px-wide Canvas strip on the right side of the chat, giving you an at-a-glance view of conversation structure and your current scroll position
- **Todo list visualization**: parses real progress from omp's `todo` tool and shows task phases and status
- **Markdown rendering, streaming output, token/time statistics**
- **Session self-healing**: if omp crashes or exits unexpectedly, the app respawns it with `-c` to continue the current session instead of splitting the chat into multiple files
- **Workspace persistence**: configuration is stored in `userData`; the workspace list survives reinstalls or device swaps

## Interaction Details

### Steer mid-run correction

While omp is in the middle of a task (reading/writing files, running commands), you can type a new instruction and send it as a **steer** to redirect or correct the current task — no need to wait for the turn to finish or start a new session.

- The input area exposes a dedicated steer entry point (icon + shortcut);
- The instruction is delivered to the target session's omp process through main-process IPC;
- The status bar shows whether the current session is in a steer state;
- Steer behavior can be tuned in the settings panel.

### Minimap density scrollbar

Borrowing the minimap idea from Codex and modern editors, the chat area renders a **14px-wide pure Canvas strip** on the right (zero runtime dependencies, redrawn with throttled `ResizeObserver` / `MutationObserver` / `scroll` handlers):

- User messages → accent-colored wide blocks; assistant messages → neutral gray narrow blocks, so you can instantly distinguish roles and density;
- A viewport indicator follows your scroll position and can be **clicked or dragged** to jump anywhere in a long conversation;
- Scrollability threshold detection: it hides when content fits one screen and restores the native scrollbar, avoiding a double-scrollbar look.

## Tech Stack

Electron 38 + React 18 + TypeScript 5.6 + electron-vite 5 + zustand 5.

## Prerequisites (required at runtime)

After launching, this GUI needs the **omp** command-line tool:

- Install via [bun](https://bun.sh): `bun install -g oh-my-pi`
- Or set the `OMP_PATH` environment variable to the absolute path of the omp executable

If neither is available, the app shows an error on startup.

## Development

```bash
npm install
npm run dev          # Start development mode (Electron window)
```

## Build

```bash
npm run build              # Compile only (electron-vite build -> out/)
npm run typecheck          # Run tsc --noEmit type check
npm run pack:portable      # Compile + package as a Windows portable exe (release/)
```

## End-to-end smoke tests (optional)

The scripts under `scripts/` spawn real omp processes to verify the protocol flow. Set `OMP_PATH` first:

```bash
export OMP_PATH="$(where omp)"   # Windows
node scripts/e2e-smoke.mjs
node scripts/e2e-session.mjs
```

## CI / Automated Builds

The repository uses GitHub Actions (`.github/workflows/ci.yml`):

- **Every push to `main` / every PR**: runs `typecheck` + `build` to verify the project compiles.
- **Tagging `v*` (e.g. `v0.2.1`)**: builds the portable exe on a Windows runner and publishes it to GitHub Releases automatically.

## License

[MIT](./LICENSE)
