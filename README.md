# Yopisora — video bot

A single-server Discord bot: `/flux-3`, `/sd2`, `/sd2-5`, `/wan-3` and `/autobypass`.

## Commands

`/flux-3` — FLUX 3
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20 seconds
- `ratio` — 16:9 (default), 9:16

`/sd2` — Seedance 2.0
- `prompt` (required)
- `duration` — 5, 10 (default), 15 seconds
- `resolution` — 480p, 720p (default)
- `ratio` — 16:9 (default), 9:16
- `img1`–`img3` — optional reference images
- `vid1` — optional reference video

`/sd2-5` — Seedance 2.5
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20, 25, 30 seconds
- `resolution` — 480p, 720p (default)
- `ratio` — 16:9 (default), 9:16, 21:9
- `img1`–`img3` — optional reference images
- `vid1` — optional reference video

`/wan-3` — WAN 3.0
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20, 25, 30 seconds
- `ratio` — 16:9 (default), 9:16
- `resolution` — 480P (832x480 / 480x832), 720P (1280x720 / 720x1280, default) —
  native output, no upscaling
- `img1`–`img3` — optional reference images (passed as reference images, not a
  first frame)
- Audio is always on. Renders over 99% of the server upload limit are
  compressed slightly (to ~98%) so they still attach.

`/autobypass` — fires N renders (from `AUTOBYPASS_COUNT` in .env) of the prompt
template with `videointro.mov` attached as the reference video, trims the intro
off every render, then replies to the initial message with one embeddable link
per clip (hosted on catbox.moe, wrapped through x266.mov so Discord plays them
inline).
- `prompt` (required) — the scene the video should cut to after the intro
- `model` — Seedance 2.5 (default, 30s, AI Studio site) or Seedance 2.0 (15s,
  open generation site)
- `img1`–`img3` — optional reference images (passed as references)
- If every render is a content violation: "All videos were content violation,
  try again".
- The batch is persisted right after the submits, so a restart mid-batch
  resumes on next boot (re-polls every render, trims, delivers).
- The intro clip is auto-padded to the provider's 1.8s reference minimum.
- The scene cut is detected with ffmpeg scene-change scores, with a luminance
  fallback.

## Setup

1. `npm install`
2. Fill `.env`: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`.
   No API keys needed — every command runs on shared internal providers.
3. `npm run register`
4. `npm start`

## Notes

- Generations are persisted to `GEN_JOB_STORE_DIR` the moment they're submitted,
  so a restart / OOM-kill / deploy mid-render resumes and delivers on next boot.
  Point it at a persistent volume if your host wipes the working dir on restart.
- The result video is streamed to disk and attached from disk to keep memory low.
- Reference images/videos are uploaded to the generation proxy and passed as
  reference media (never as a first frame).
- Provider-specific error reasons are shown to the user (e.g. reference video
  duration limits, copyright / content-policy blocks) with backend identifiers
  redacted; full raw errors go to console only.
- `npm start` caps the V8 heap (`--max-old-space-size=640`) for small (~1 GB)
  hosts; lower it to `512` if needed.
