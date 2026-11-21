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
render.yaml          one-click Render Blueprint
```

## How the multiplayer works

* **The server is the referee.** Every action (place, upgrade, sell, ultimate, target mode, start wave) is sent to the server as a *command*. The server runs its own headless copy of the game, applies each command to it, and only commands that are legal *in that authoritative game* (enough gold, free spot, your own troop, in your squad, host-only wave start, rate limits, no duplicates) are accepted. Rejected commands never reach other players.
* **Everyone sees the same match.** Accepted commands are numbered into 100 ms "turns" and broadcast. The game simulation is deterministic (seeded), so every browser applies the same commands on the same tick and gets the same enemy positions, enemy health, kills, waves and boss. A defeated enemy disappears for everyone because it is defeated in everyone's identical simulation.
* **Drift is detected.** Every 5 seconds the server includes a hash of its own state; a browser whose state differs is automatically resynchronised.
* **Reconnects.** Players get a seat for 2 minutes. After a short connection drop the browser asks for only the turns it missed (`game:resume`) and carries on; a refreshed page rebuilds the match from the full command log (`game:sync`). While every player is offline the match is held, not advanced. If the host leaves the lobby the next player becomes host immediately; if the host drops mid-match, host passes on after ~8 s so waves can always be started.
* **Economy:** each player has their own gold; kills pay the owner of the troop that scored them; wave-clear bonuses go to everyone. Base lives are shared.

## Tests

```bash
npm test   # lobby/match flows, resume after drops, host migration, DB outage, long lockstep run (no network needed)
```

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

## Limits worth knowing

* Unlocked troops/coins stay in each player's own browser save; the server checks that a placed troop is in the player's declared 10-troop squad, not that it is unlocked.
* Match coin rewards are credited by each player's own browser to their own save.
* Only the host can start waves, toggle **Auto** (each next wave starts by itself ~2 s after the previous one ends) and change the game speed (1x/2x/3x); both apply to everyone. There is no pause in multiplayer.
* Friend requests are stored and can be accepted; inviting a friend into a room is not built yet.

## Packs & unlocks

Legendary and Mythical pull rates were cut sharply (e.g. Recruit Pack 0.25% / 0.05%); direct-unlock prices were tuned up a little (Epic 820 / Legendary 1,750 / Mythical 3,000 coins). Pack guarantees are unchanged. Unlocking an Epic, Legendary or Mythical card plays a charge-up, flash, shockwave, particle burst and name banner (skipped for reduced-motion users).

## Creator class

A new class (its own filter in the Squad and Collection screens) with three troops:

* **Chuck** (Mythical, gold support): *Payday* pays his owner gold every few seconds during a wave, *Tip Jar* pays a bonus on every enemy that dies in his range, and the ultimate *Golden Hour* gives a lump sum and doubles both for about 11 seconds. In co-op the gold goes only to the player who owns Chuck.
* **Lachlan** (Legendary, builder): Genesis Bolts (every 4th is a Divine Spark), temporary crystal Constructs that shoot and slow, and the ultimate *Let There Be Light* (a Blueprint Realm that slows and burns enemies and conjures extra Constructs).
* **Ozan** (Legendary, frontline): molten clay shots, Clay Golems that block and fight on the path, and the ultimate *Mass Forging* (stunning shockwave plus a squad of Golems).

`npm test` includes `test/creators.test.js` (deploy, income goes to the right player, summons, ultimates, server/client sync).

## Balance pass

Troops were compared on damage per second per 100 gold within each rarity (support troops excluded), and the clear outliers were pulled toward their band.
* **Nerfed:** Royal Assassin (320g, 66 dmg, 1.25/s), Agent Zero (850g, 180 dmg), Sabertooth (42 dmg, 1.45/s), Archer (20 dmg), Terror Bird (2.8/s), Spec Ops (74 dmg), Ballista (200g), Combat Sniper (330g).
* **Buffed:** Pachycephalosaurus (78), Siege Engineer (52), Spinosaurus (115), Mammoth Rider (150 dmg, 620g), Vampire Lord (84), Loki (68), Heavy Weapons (560g), Venom (92), Simo Hayha (680 dmg, 0.3/s, 1050g), Egyptian Pharaoh (128), Royal Dragon Archer (126), Cerberus (76).
* **Creators:** Lachlan's Constructs were doing roughly 95 dps each; now one shot per second at lower damage, fewer of them, and a weaker Blueprint Realm. Chuck's Payday and Tip Jar are softer, extra Chucks pay half Payday and only the best Tip Jar applies per enemy, so stacking him is not a free snowball. Ozan +8 dmg, Chuck +6 dmg.

**Creator buffs (slight):** Chuck 38 dmg, Payday base +1, Tip Jar +1%; Lachlan 72 dmg and stronger Constructs; Ozan 72 dmg and tougher, harder-hitting Golems. All three also got new signature portrait effects (sunburst and coin fountain, blueprint mandala and light shafts, forge glow, anvil and hammer sparks).
