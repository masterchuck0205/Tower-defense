# Stone & Crown: Mythic Pantheon - Online Co-op

Your existing tower defence game with **real online multiplayer**: up to 4 players defend the same realm, fight the same waves and bosses, and see each other's troops. Single-player is unchanged.

```
server.js            Express + Socket.IO entry point (uses process.env.PORT)
lib/rooms.js         rooms, lobby, matchmaking, reconnects, the authoritative match loop
lib/engine-host.js   runs the game's real simulation headlessly on the server (the referee)
lib/store.js         PostgreSQL store (or in-memory fallback)
db/schema.sql        tables: players, friendships, matches
public/index.html    the game (original game + a small multiplayer core; still works offline)
public/multiplayer.* menu, lobby, networking and in-match HUD
test/                automated tests (see "Testing")
render.yaml          one-click Render Blueprint
```

## How the multiplayer works

* **The server is the referee.** Every action (place, upgrade, sell, ultimate, target mode, start wave) is sent to the server as a *command*. The server runs its own headless copy of the game, applies each command to it, and only commands that are legal *in that authoritative game* (enough gold, free spot, your own troop, in your squad, host-only wave start, rate limits, no duplicates) are accepted. Rejected commands never reach other players.
* **Everyone sees the same match.** Accepted commands are numbered into 100 ms "turns" and broadcast. The game simulation is deterministic (seeded), so every browser applies the same commands on the same tick and gets the same enemy positions, enemy health, kills, waves and boss. A defeated enemy disappears for everyone because it is defeated in everyone's identical simulation.
* **Drift is detected.** Every 5 seconds the server includes a hash of its own state; a browser whose state differs is automatically resynchronised.
* **Reconnects.** Players get a seat for 2 minutes. A returning browser (even after a page refresh) receives the match's command log and replays it to catch up. If the host leaves, the next player becomes host.
* **Economy:** each player has their own gold; kills pay the owner of the troop that scored them; wave-clear bonuses go to everyone. Base lives are shared.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```
Open the address in two browser windows (or on two devices on your network), click **Multiplayer**, create a room in one and join with the code in the other. To test alone, use `MIN_PLAYERS=1 npm start`.
Without `DATABASE_URL` the server keeps accounts in memory (they vanish on restart).

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP/WebSocket port (Render sets it) | 3000 |
| `DATABASE_URL` | PostgreSQL connection string | empty = in-memory |
| `DATABASE_SSL` | `false` if your Postgres has no SSL | true |
| `MIN_PLAYERS` | players needed to start | 2 |
| `MAX_ROOMS` | simultaneous rooms | 40 |
| `RECONNECT_GRACE_MS` | seat kept for a dropped player | 120000 |
| `CORS_ORIGIN` | only if the page is hosted elsewhere | none |

Secrets live only in environment variables; `.env` is git-ignored. Player session tokens are stored hashed in the database.

## Database setup (optional but recommended)

The server creates its tables automatically at start (`db/schema.sql`). Locally:
```bash
createdb stonecrown
export DATABASE_URL=postgres://localhost:5432/stonecrown DATABASE_SSL=false
npm start
```
Stored: guest accounts (name, avatar, selected squad, hashed token), friend requests, finished match history. Players never need to register: the browser keeps a secret token and is recognised next visit.

## Upload to GitHub

```bash
cd stone-and-crown-online
git init && git add . && git commit -m "Stone & Crown online"
git branch -M main
git remote add origin https://github.com/<you>/stone-and-crown-online.git
git push -u origin main
```
(Create the empty repository on github.com first. Do not commit `.env`.)

## Deploy on Render

**Blueprint (easiest):** Render dashboard > New > Blueprint > choose the repository. `render.yaml` creates the web service and a PostgreSQL database and wires `DATABASE_URL`.

**Manual:** New > Web Service > the repository. Runtime Node, Build `npm install`, Start `npm start`, Health Check Path `/healthz`, Environment `NODE_VERSION=22`. Optionally create a PostgreSQL database and set `DATABASE_URL` to its *Internal* connection string (if you see an SSL error, set `DATABASE_SSL=false`).

Good to know:
* WebSockets work on Render out of the box. Run **one instance** only: rooms live in that server's memory.
* Free web services sleep when idle (first visit takes ~30-60 s) and a restart ends running matches. Free Render Postgres databases expire after 30 days.
* Share the site URL, or the invite link from the lobby (`?room=CODE`).

## Testing

```bash
npm test         # engine determinism, server rules, 4-player match
npm run test:e2e # two real browsers (needs: pip install playwright && playwright install chromium)
E2E_REAL=1 python3 test/e2e.py   # same browser test against the real Express + Socket.IO server
```
`npm test` and the e2e scripts use a small test-only WebSocket stand-in (`test/mini-socketio.js`) unless `E2E_REAL=1`.

**What was verified while building this** (Node 22, Chromium): the game simulation is identical between independent copies over a 5-minute match; create/join/room codes, 4-player limit, ready sync, host-only start/settings/kick, matchmaking, start-together, identical turn streams for 2 and 4 players, placement/currency/ownership/duplicate/rate-limit validation, host-only wave start and the shared boss bar, state hashes equal across two browsers (including enemy health) through a boss wave, dropped-socket reconnect, mid-match page refresh, leaving mid-match, rematch flow, single-player and offline play.

**Not verified** (the build environment had no internet): the real `express`, `socket.io` and `pg` packages and PostgreSQL (the code follows their standard v4/8.x APIs, and `E2E_REAL=1` lets you check it in a minute), an actual Render/GitHub deployment, real-internet latency, Firefox/Safari/mobile (determinism relies on the browsers computing identical floating-point maths; Chromium-based browsers are tested - if a browser drifts it is resynchronised, repeated drift shows a "rejoin" message), and matches with 3-4 players in real browsers (3-4 players were tested at server level only).

## Limits worth knowing

* Unlocked troops/coins stay in each player's own browser save; the server checks that a placed troop is in the player's declared 10-troop squad, not that it is unlocked.
* Match coin rewards are credited by each player's own browser to their own save.
* No speed change or pause in multiplayer; only the host starts waves.
* Friend requests are stored and can be accepted; inviting a friend into a room is not built yet.
