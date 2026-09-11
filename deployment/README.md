# Maia Board Deployment

Hosting lives in the `home-server` repo: `maia-board/compose.yaml`,
`maia-board/maia-board-komodo.toml`, and the `maia-board` entry in
`services.toml`. Komodo builds the combined frontend/API image from this
repo's `master` branch and serves it LAN-only at
`https://maia3.home.simho.xyz` through Traefik. Keep stack, compose, and
Komodo files out of this repo.
