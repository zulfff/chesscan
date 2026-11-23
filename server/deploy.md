# Deploying chesscan-server

The server is one static-ish Rust binary with no database and no external
dependencies. It listens on one port and streams newline-delimited JSON. These
are three ways to run it: on your laptop, as a systemd service, or in a
container.

## 1. Run it on your laptop

```bash
cd server
cargo build --release
PORT=8787 ./target/release/chesscan-server
```

Then open <http://127.0.0.1:8787/v1/health>. In the extension, set **src** to
`server` and put `http://127.0.0.1:8787` in the gear menu.

To run it in the background and have it come back after a reboot:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/chesscan-server.service ~/.config/systemd/user/chesscan-server.service
systemctl --user daemon-reload
systemctl --user enable --now chesscan-server
systemctl --user status chesscan-server
```

The unit file references `/opt/chesscan` and a `chesscan` system user; for the
user unit, edit `ExecStart` to the real path of the binary and drop the `User=`
line.

## 2. Build once, copy the binary

Any machine with the same CPU architecture and a new enough glibc runs the
binary you already built:

```bash
cargo build --release --target x86_64-unknown-linux-gnu
scp target/x86_64-unknown-linux-gnu/release/chesscan-server user@host:/opt/chesscan/
```

Check the glibc requirement with `ldd chesscan-server`; on Debian 12 / Ubuntu 24.04
it is fine as-is.

## 3. systemd service (the normal way on a small box)

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin chesscan
sudo mkdir -p /opt/chesscan
sudo cp target/release/chesscan-server /opt/chesscan/
sudo chown -R chesscan:chesscan /opt/chesscan
sudo cp deploy/chesscan-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chesscan-server
curl -s localhost:8787/v1/health
```

Set a token, because a bind to `0.0.0.0` with no token means anyone who can reach
the port can spend your CPU:

```bash
sudo systemctl edit chesscan-server
# [Service]
# Environment=CHESSCAN_TOKEN=replace-me
sudo systemctl restart chesscan-server
```

Then put the same token in the extension's gear menu.

### Exposure

- **Same machine / LAN:** nothing else to do. The extension can use
  `http://<lan-ip>:8787`.
- **Over the internet:** do not expose the port directly. Put it behind a
  reverse proxy with TLS, or reach it over a WireGuard/Tailscale network. A
  minimal Caddy config:

  ```
  chess.example.com {
      reverse_proxy 127.0.0.1:8787
  }
  ```

  With TLS in front, the extension should use `https://chess.example.com`.
- **Firewall:** if you must expose the port, restrict the source addresses:

  ```bash
  sudo ufw allow from 203.0.113.7 to any port 8787 proto tcp
  ```

## 4. Docker (optional)

```dockerfile
FROM rust:1-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd --system --create-home chesscan
COPY --from=build /src/target/release/chesscan-server /usr/local/bin/chesscan-server
USER chesscan
EXPOSE 8787
ENV PORT=8787
ENTRYPOINT ["chesscan-server"]
```

```bash
docker build -t chesscan-server .
docker run -d --name chesscan -p 8787:8787 --restart unless-stopped \
  -e CHESSCAN_TOKEN=replace-me chesscan-server
```

## Configuration reference

| Variable                  | Default | Meaning                                    |
| ------------------------- | ------- | ------------------------------------------ |
| `PORT`                    | `8787`  | Listen port                                |
| `CHESSCAN_TOKEN`          | unset   | Require `Authorization: Bearer <token>`    |
| `CHESSCAN_MAX_JOBS`       | cores   | Concurrent searches; excess gets HTTP 429  |
| `CHESSCAN_SOLVER_PIECES`  | `6`     | Exact solver only at or below this         |
| `CHESSCAN_SOLVER_NODES`   | `5e6`   | Solver node budget                         |
| `CHESSCAN_SOLVER_DEPTH`   | `16`    | Solver ply horizon                         |

## Verify it is working

```bash
curl -s localhost:8787/v1/health
curl -s -X POST localhost:8787/v1/analyze \
  -H 'content-type: application/json' \
  -d '{"fen":"6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1","depth":20}' \
  | tail -1
```

The second command should report `"bestmove":"e1e8"`, `"proven":true` and
`"mate_in":1`.
