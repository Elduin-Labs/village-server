# Village Server

A Minecraft 1.21.11 server where spawn is a beautiful village, with
everything you need.

Everything runs on **one port, 23377**:

- **Play:** in Minecraft, go to Multiplayer and add `localhost:23377`.
- **Website:** open <http://localhost:23377> in a browser.

## What you get

- **Spawn in a village.** The first time the world starts, the server finds
  the nearest village and moves spawn right into the middle of it.
- **A starter kit.** The first time you join you get iron tools, a shield,
  food, torches, logs, a crafting table, a furnace, a bed and 16 emeralds
  for trading with the villagers.
- **The website** shows whether the server is on, the day and time, how many
  villagers there are, who's playing (health, food, level, where they are
  and how far from the village), the starter kit, and a feed of chat, joins,
  deaths and advancements.
- **Minecraft Wiki lookup** on the website. Search for any mob, block or item
  and read the wiki page right there.

## Start it

```bash
docker compose up -d --build
```

Stop it with `docker compose down`. The world lives in a Docker volume, so it
survives restarts.

## How it works

`site/server.js` listens on 23377 and checks the first bytes of each
connection. Browsers get the website; Minecraft clients are passed through to
the real server. It talks to the game over RCON every two seconds, and that's
also how it sets the village spawn and hands out starter kits.

The wiki lookup uses the Minecraft Wiki MCP server from the Docker MCP
catalog. The website's image is built on top of it (`site/Dockerfile`) and
runs it as a helper.

Made by Elduin.
