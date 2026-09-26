# Maia Board Deployment

Hosting lives in the `home-server` repo: `maia-board/compose.yaml`,
`maia-board/maia-board-komodo.toml`, and the `maia-board` entry in
`services.toml`. Komodo builds the combined frontend/API image from this
repo's `master` branch and serves it LAN-only at
`https://chess.home.simho.xyz` through Traefik. Tailnet clients use the
service-directory "Tailnet port" link (`http://debian-server.<tailnet>:18080`,
bound to the tailnet interface only). Managed stack, compose, and
Komodo files stay in that repository; the root [`compose.yaml`](../compose.yaml)
is the local self-hosting example.
