# lovense-mcp

**English** · [中文](README.zh-CN.md)

By Rosalie

## Overview

**Control Lovense toys from the Claude app on your phone, in plain language.** Deploy once; your computer can stay off.

This is an MCP server that runs on Cloudflare Workers and forwards commands through Lovense's official cloud interface (Standard API). Tested on a **Lovense Vulse**.

Three things it does differently:

- **Phone-only after setup.** The Worker is stateless and always on; the free tier is plenty.
- **MCP spec 2026-07-28.** Stateless Streamable HTTP, with fallback for older clients (2025-11-25 / 2025-06-18 / 2025-03-26), so both new and old Claude clients connect.
- **Access key, fail-closed.** The key lives in the URL path, no OAuth to configure. With no key configured, the Worker refuses every request.

Other Lovense toys use the same API and should work, but only the Vulse has been tested.

> Adults only. Use only on devices you own.

## How it works

A command leaves Claude, passes through the Worker and Lovense's cloud, and reaches the toy over Bluetooth from the Lovense Remote app on your phone.

```text
Claude app (phone / web)
   │  MCP · Streamable HTTP · key in the URL
   ▼
Cloudflare Worker (this project)
   │  HTTPS · Lovense Standard API
   ▼
Lovense cloud
   │  pushed to the paired phone
   ▼
Lovense Remote app (phone)
   │  Bluetooth
   ▼
Toy
```

On each call the Worker does three things: checks the key in the URL, translates tool arguments into Lovense API calls, and forwards them. Pairing state lives on Lovense's servers; the Worker stores nothing.

Lovense commands carry their own duration, so one call runs for the requested time without the client re-sending. Few calls per session means the context cost is negligible.

## Tools

Once the connector is attached, Claude sees 6 tools. You speak normally; Claude picks the tool.

| Tool | What it does | Main arguments |
| --- | --- | --- |
| `lovense_pair_qr` | Generate a pairing QR code to scan with Lovense Remote | none |
| `lovense_vibrate` | Set vibration intensity | intensity 0–20, duration in seconds |
| `lovense_thrust` | Set thrusting speed (thrusting toys) | intensity 0–20, duration in seconds |
| `lovense_pattern` | Play a built-in pattern preset | preset name, duration |
| `lovense_custom_pattern` | Play a custom intensity sequence | intensity list, interval |
| `lovense_stop` | Stop everything immediately | none |

Patterns run on the Vibrate channel by default; thrusting toys can pass `function: "thrusting"`. Preset names and exact argument schemas are defined in `src/tools.js`.

## Tested device: Lovense Vulse

**The Vulse responds to `lovense_vibrate` only. `lovense_thrust` does nothing.**

Lovense markets the Vulse as a thrusting egg (up to 120 strokes/min, 10 mm travel), so the thrust command looks like the obvious choice. In practice:

- Lovense Remote shows a single Vibration slider for it.
- The Lovense API exposes only the Vibrate channel. Thrust and vibration share one motor and cannot be driven separately.
- A Thrusting command returns success from the API, and the toy stays still.

So ask for "vibration" when driving a Vulse, and build patterns on the Vibrate channel too.

Thrusting toys such as the Solace should respond to `lovense_thrust`, but that is untested here. The Lovense API also has a Depth command (0–3); this project does not implement it.

## Prerequisites

Everything is free. The computer is needed once, for deployment.

| You need | Notes |
| --- | --- |
| Lovense developer account | Sign up at [developer.lovense.com](https://developer.lovense.com) to get a Developer Token |
| Cloudflare account | Free tier is enough; the Worker runs here |
| A computer (one time) | Windows / Mac / Linux with Node.js 20+; not needed after deployment |
| Claude account | A plan that allows custom connectors |
| Lovense Remote on your phone | The toy connects to it over Bluetooth; keep it running while you play |
| A Lovense toy | Tested on the Vulse |

## Deploy

If you have Claude Code, you can hand it the repo URL: "Deploy this repo to my Cloudflare and install whatever is missing." Apart from authorizing Cloudflare in the browser and pasting your token, it can run every command below.

1. Clone and install:

   ```bash
   git clone https://github.com/rosaliev24/lovense-mcp.git
   cd lovense-mcp
   npm install
   ```

2. Log in to Cloudflare (opens a browser to authorize):

   ```bash
   npx wrangler login
   ```

3. Generate an access key and keep it somewhere safe:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

4. Store your Lovense token and the access key. Paste at each prompt and press Enter; nothing shows while you paste, which is normal:

   ```bash
   npx wrangler secret put LOVENSE_TOKEN
   npx wrangler secret put MCP_ACCESS_KEY
   ```

   Do not pipe the value in with `echo "xxx" | wrangler secret put`; always paste interactively (see Troubleshooting).

5. Deploy:

   ```bash
   npx wrangler deploy
   ```

   The output shows your Worker address, like `https://lovense-mcp.<subdomain>.workers.dev`.

6. Verify (protocol checks only; sends nothing to the toy):

   ```bash
   node scripts/check.mjs https://lovense-mcp.<subdomain>.workers.dev <key>
   ```

7. Set the Lovense callback URL (**required**): at lovense.com/user/developer/info, set the Callback URL to

   ```text
   https://lovense-mcp.<subdomain>.workers.dev/lovense/callback
   ```

   Without it, Lovense rejects the QR code request even with a correct token.

## Connecting Claude

### Add a custom connector

The connector URL is the Worker address + `/mcp/` + your key:

```text
https://lovense-mcp.<subdomain>.workers.dev/mcp/<key>
```

1. Open [claude.ai](https://claude.ai) in a browser → Settings → Connectors → **Add custom connector**.
2. Any name (e.g. Lovense), paste the URL above as the remote MCP server URL, leave both OAuth fields empty, click Add.
3. The connector's detail page should list 6 tools. Permissions default to "ask first"; switch to auto-allow once you trust it.

The iOS Claude app currently has no "add custom connector" entry. Add it on the web; the phone app picks it up after a restart.

### Pair the toy (one time)

1. Open Lovense Remote on your phone and connect the toy over Bluetooth.
2. Start a new Claude conversation and ask for a pairing QR code. Approve the permission prompt on first use.
3. Scan the code from inside Lovense Remote. Codes expire within minutes; ask for a fresh one if it fails.

Pairing is stored on Lovense's servers. You will not need to scan again.

## Daily use

Two steps each time: open Lovense Remote with the toy connected, then talk to Claude.

Examples:

- "Vibrate at 8 for 30 seconds"
- "Play one of the presets"
- "Ramp up from 3 to 15, five seconds per step"
- "Stop"

Claude picks the tool and fills in the arguments. Start low (around 3) for a few seconds the first time.

Keep in mind:

- Lovense Remote must stay running and the toy must stay connected over Bluetooth. If the app is killed, commands report success but nothing moves.
- Say "vibrate", not "thrust", for a Vulse (see Tested device).
- Each call costs roughly 100–200 tokens, plus a one-time ~1–2k for the tool definitions. An hour of play is a rounding error in context.

## Security

**The full connector URL is the credential.** Anyone who has it can drive your toy. Do not screenshot it or paste it into chats.

- **Fail-closed.** With no `MCP_ACCESS_KEY` configured, the Worker returns 401 to everything; there is never an unprotected window. A wrong key also gets 401.
- **Whitespace-tolerant key comparison**, so a stray newline from copy-paste cannot lock you out.
- **No secrets in code.** The Lovense token and access key live in Cloudflare secrets, never in source or git. The locally generated `.access-key.txt` is in `.gitignore`.
- **The Worker stores nothing.** No command logs, no pairing data.

### Rotating the key

If you suspect a leak, or the URL ever appeared in a chat log, rotate it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put MCP_ACCESS_KEY    # paste the new key
```

Then update the URL in the claude.ai connector settings. The old URL stops working immediately; no redeploy and no re-pairing needed.

## Troubleshooting

Every row below actually happened, listed in deployment order.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Developer application says "account does not exist or password incorrect" | The application form is also a login form; it wants an existing Lovense account's password | Register and log in at lovense.com first, then apply |
| Two tokens appear in the developer dashboard | "Add new token" was clicked by mistake | Use the first one; delete the extra |
| Deploy succeeds but the URL does not resolve | No workers.dev subdomain registered yet | Cloudflare dashboard → Workers & Pages → register one |
| 401 forever after setting the secret | Used `echo "xxx" \| wrangler secret put`; PowerShell appended a newline | Use interactive `wrangler secret put` and paste at the prompt |
| Still 401 right after setting the secret | Secret propagation delay | Wait 10–20 seconds and retry |
| QR code request returns "Please set your Callback URL in your developer dashboard" | Lovense requires a callback URL; a correct token is not enough | Set Callback URL to the full `/lovense/callback` address |
| Callback URL shows "please enter a URL" and will not save | On a phone in portrait, the form collapses and another section's validation blocks the whole submit | Rotate the phone to landscape and Save, or use a desktop browser |
| Callback endpoint returns 405 on GET | Cloudflare edge cached an old response | Current version returns 200 for GET/HEAD/POST; retry with a random query parameter |
| No "add custom connector" in the iOS Claude app | The app has no such entry | Add it at claude.ai on the web; the app syncs |
| Scanning the QR fails | Codes expire within minutes | Generate a new one and scan immediately |
| Command succeeds, toy does not move | Lovense Remote was killed or Bluetooth dropped; or the command uses a channel the toy lacks | Keep Remote running; use vibrate for the Vulse |

## Known limitations

- Tested only on the Lovense Vulse. Other models are unverified.
- Depth is not implemented.
- Cloud only; Lovense's local LAN mode is not implemented.
- No OAuth. Auth is the key in the URL: fine for one person, not for sharing.

## Development

```bash
npm test                    # unit tests, fully mocked, never touch a real device
npx wrangler dev            # local server, reads .dev.vars (see .dev.vars.example)
node scripts/check.mjs      # protocol checks against the local instance
npx wrangler tail           # live logs
```

## Credits

- [amarisaster/Lovense-Cloud-MCP](https://github.com/amarisaster/Lovense-Cloud-MCP): the original reference for the Cloudflare Worker approach.
- [Lovense Standard API docs](https://developer.lovense.com/docs/standard-solutions/standard-api.html)
- [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Code generated with Claude Code. Design, on-device testing and the troubleshooting above by Rosalie.

## License

MIT © Rosalie. See [LICENSE](LICENSE).
