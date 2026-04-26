# AGENTS.md

## Project

Discord music bot ("runrunpomi") — Node.js + TypeScript. Comments and user-facing strings are in Japanese.

## Commands

- **Run (manager)**: `npm start` or `npm run dev` — starts TUI dashboard that manages all bot instances
- **Run (single)**: `npm run bot` — runs a single bot instance (for development, uses BOT_1_TOKEN)
- **Build**: `npm run build` — compiles TypeScript to `dist/`
- **Unregister commands**: `npm run unregister` — wipes slash commands from all configured bots
- **Tests / Lint / Typecheck**: none configured

## Architecture

```
src/
├── manager.ts          TUI dashboard entry point (npm start)
├── index.ts            Bot instance entry point (spawned as child process)
├── types.ts            All type definitions including IPC messages
├── ipc.ts              Type-safe parent↔child IPC helpers
├── state.ts            Queue map, VC/volume persistence, per-instance file paths
├── commands.ts         Slash command definitions + all command handlers
├── player.ts           Playback logic (playSong, preDownload, processSongs)
├── audio.ts            Audio processing (LUFS measurement via ffmpeg, lyrics from lrclib.net)
├── ui.ts               Discord embeds, buttons, progress bars, lyrics display
├── interactions.ts     Button and select menu component handlers
├── tui/
│   ├── dashboard.ts    blessed TUI layout and rendering
│   └── ascii.ts        ASCII art banner
├── lib/
│   └── defaultEmbed.ts Custom EmbedBuilder subclass with branded footer/color
└── scripts/
    └── unregister_commands.ts  Wipes slash commands from all bot instances
```

## Multi-instance manager

- Manager spawns up to 5 bot instances as child processes via `fork()`
- Communication via IPC: status updates, log forwarding, shutdown/restart commands
- TUI shows ASCII art, per-instance status (online/playing/offline), and latest 3 log lines
- Auto-restarts crashed instances with exponential backoff (1s→2s→4s→...→max 30s)
- Intentional stops (Q/S keys) prevent auto-restart
- Keyboard controls: `[1-5]` restart instance, `[S]` stop all, `[Q]` quit

## Runtime dependencies

- **System binaries**: `yt-dlp` and `ffmpeg` must be on PATH
- **`.env`** must define `GUILD_ID` and `BOT_1_TOKEN` through `BOT_5_TOKEN` (+ optional `BOT_*_NAME`)

## Runtime state (gitignored)

- `downloads/` — temp audio files, auto-created and cleaned up during playback
- `active_vcs_{n}.json` — persists VC connections per instance across restarts
- `volume_settings_{n}.json` — per-guild volume persistence per instance
- `.env` — bot tokens and guild ID

## Key behaviors

- Slash commands are registered **guild-scoped** on every `ready` event
- Audio playback: songs ≤2h are downloaded first; longer/livestreams use stdout streaming
- Next song is pre-downloaded while current song plays
- LUFS loudness measurement via `ffmpeg loudnorm` filter on each track (using `execFile`, not string interpolation)
- Synced lyrics fetched from `lrclib.net` API and displayed in real-time
- Bot auto-reconnects to VCs on restart using state files
- Bot disconnects automatically when all humans leave the VC
- Default audio filter is `loudness` (loudness normalization)
- `handleStop` sets `stopped` flag to prevent Idle listener from sending redundant messages

## Conventions

- All embeds go through `CustomEmbed` (`lib/defaultEmbed.ts`) — do not use raw `EmbedBuilder` for user-facing messages
- `processSongs` and command handlers use `interaction.deferred || interaction.replied` branching instead of dynamic method access for type safety
- `Song` interface requires both `url` and `webpage_url` fields (both set to the same value from yt-dlp output)
