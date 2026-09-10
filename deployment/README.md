# Maia Board Deployment

This directory contains the Komodo-managed LAN deployment for the combined
Maia board image. The target host is `debian-server`; Traefik is the only
entry point and the service publishes no host port.

## Current Assumptions

- Komodo has a Git-backed Repo resource named `maia-board` that points to this
  repository and tracks branch `master`.
- The repository's deployment files are available to that resource at
  `deployment/compose.yaml` and `komodo/maia-board-komodo.toml`.
- The combined frontend/API image will eventually be published as
  `ghcr.io/simhozebs/maia-board:<immutable-tag-or-digest>`.
- The current checkout has no registered Git/Komodo source and no combined
  image. The compose file therefore uses the explicit placeholder
  `ghcr.io/simhozebs/maia-board:pending-frontend-integration` with
  `pull_policy: never`. Replace that reference and remove `pull_policy` only
  after the frontend image integration is complete and the image is available
  to `debian-server`.
- The current prototype listens on container port `8080`, serves `GET /healthz`,
  and accepts `POST /move`. The final combined image must preserve that port
  and API contract.

The placeholder is intentionally not deployable. Actual deployment waits for
frontend/image integration and a registered Git/Komodo source.

## Prerequisites

- Komodo Core has the `debian-server` Server resource connected to its
  Periphery agent.
- Komodo has a Repo resource named `maia-board` with read access to the Git
  repository and branch `master`.
- The image has been integrated and published under the final immutable image
  reference, or the compose file has been deliberately changed to the
  approved Komodo build mechanism.
- The existing Traefik stack is running on `debian-server` and owns the
  external Docker network named `traefik`.
- Traefik's Docker provider uses the `traefik` network, exposes only labeled
  containers, and has the `websecure` entrypoint. These are the current
  `home-server` settings.
- LAN DNS resolves `maia3.home.simho.xyz` to the LAN address of
  `debian-server`. Add an AdGuard local rewrite for that hostname, or an
  equivalent hosts entry on each client. Do not create a public DNS record.
- The existing LAN certificate setup covers `*.home.simho.xyz`. If that
  certificate or split-DNS setup changes, update the LAN routing plan before
  deploying.

## Routing

Traefik routing is defined by Docker labels in `compose.yaml`:

- Host rule: `maia3.home.simho.xyz`
- Entry point: `websecure` with TLS
- Backend: container port `8080` on the external `traefik` network
- Public routers: none
- Direct host ports: none

The route follows the existing `home-server` split-DNS convention. LAN clients
connect directly to Traefik on `debian-server`; Cloudflare or another public
proxy is not in the request path.

## Komodo Operations

Use the `maia-board` Stack in Komodo. Do not run Docker or Docker Compose
lifecycle commands on the host.

- **Deploy** runs the Stack's Compose deployment and is required after image,
  service, network, volume, label, or environment changes. It can recreate the
  container and applies the current Git/image configuration.
- **Restart** restarts the existing container in place. It does not update the
  image reference or apply Compose changes, so it is suitable only for a
  runtime restart with unchanged configuration.
- **Rollback** is owned by the Komodo operator. Deploy a known-good Git commit
  and immutable image reference through the Stack, then verify the route and
  `/healthz`. Keep `maia-board-model-cache` when rolling back so cached Maia
  models survive container replacement. Keep `maia-board-game-data` so game
  history survives as well.
- **Teardown** is owned by the Komodo operator through the Stack's stop/down
  or delete operation. Preserve the model-cache volume unless removing Maia
  data is intentional, and preserve the game-data volume unless removing game
  history is intentional. The existing Traefik stack and its `traefik` network
  remain owned by the home-server deployment and must not be changed here.

The stack declaration deliberately does not enable automatic deployment. A
reviewed Komodo source registration and an explicit deployment are required.

## Verification Checklist

Before deployment:

- Confirm the frontend assets and combined image integration are present.
- Replace the placeholder image with an immutable published tag or digest and
  remove `pull_policy: never`.
- Confirm the `maia-board` Repo resource and `debian-server` Server resource
  exist in Komodo.
- Confirm the external `traefik` network and existing Traefik stack are
  healthy.
- Confirm LAN DNS resolves `maia3.home.simho.xyz` to the `debian-server` LAN
  address and has no public DNS record.
- Validate the TOML and Compose YAML locally without deploying.

After an approved Komodo deployment:

- Confirm the Stack reports one running `maia-board` service on
  `debian-server`.
- Confirm the service is attached to `traefik`, has no host-published port,
  and has only the named `maia-board-model-cache` and `maia-board-game-data`
  persistent volumes.
- From a LAN client, open `https://maia3.home.simho.xyz/` and confirm the
  certificate and static UI.
- From a LAN client, request `https://maia3.home.simho.xyz/healthz` and
  confirm a successful response.
- Exercise one `POST /move` request through the hostname and confirm the
  response identifies the selected model and fallback state.
- Confirm Traefik reports the `maia-board` router and service as healthy.
- Confirm no public DNS entry or non-Traefik host port was added.

## References

- [Komodo Docker Compose Stacks](https://komo.do/docs/deploy/compose)
- [Komodo Resource Sync TOML](https://komo.do/docs/automate/sync-resources)
- [Komodo Stack configuration schema](https://docs.rs/komodo_client/latest/komodo_client/entities/stack/struct.StackConfig.html)
- [Traefik Docker provider](https://doc.traefik.io/traefik/providers/docker/)
- [Traefik HTTP routers](https://doc.traefik.io/traefik/routing/routers/)
