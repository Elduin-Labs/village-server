# Built on top of the Minecraft Wiki server from the Docker MCP catalog
# (the one in the Docker profile), so the website can look things up on the
# wiki by talking to it directly.
FROM mcp/minecraft-wiki@sha256:b191b5c6725ba90954bd86956afd1555d44fd58a1984f9e96a7657e029ad57fd
WORKDIR /site
COPY server.js index.html ./
EXPOSE 23377
ENTRYPOINT ["node", "/site/server.js"]
