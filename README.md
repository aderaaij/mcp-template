# mcp-template — boilerplate for self-hosted MCP servers

A small generator for spinning up [Model Context Protocol](https://modelcontextprotocol.io)
servers that all share one shape: a `systemctl --user` unit exposing
**streamable HTTP** on a local port. Python servers are built on
[FastMCP](https://github.com/jlowin/fastmcp) and serve HTTP **natively,
in-process** (endpoint `/mcp`) — no gateway, no per-session child processes —
sharing an `app/main.py` + `app/config.py` + `app/tools/<domain>.py` layout.
Third-party **stdio** MCPs are wrapped through a shared, patched
[**supergateway**](https://github.com/supercorp-ai/supergateway) install
(`--stdio` mode) instead.

`new-mcp` factors that out so a new server is "write the tools", not
"copy-paste an existing one and find-replace".

> The generated server binds `0.0.0.0` — put it behind your own LAN, VPN,
> Tailscale, or reverse proxy; it does no auth of its own.

## Requirements

- [`uv`](https://github.com/astral-sh/uv) (Python project + deps), for Python servers
- `node` + `npm` (runs supergateway) — only needed for `--stdio` wraps
- `systemd` user services (Linux)

## Install

```bash
git clone https://github.com/aderaaij/mcp-template.git ~/mcp-template
~/mcp-template/mcp-common/bootstrap.sh          # -> ~/.local/share/mcp-common (npm ci)
ln -sf ~/mcp-template/new-mcp ~/.local/bin/new-mcp
```

`bootstrap.sh` installs the shared, version-pinned supergateway (see
[Shared supergateway](#shared-supergateway)).

## Quick start

```bash
new-mcp weather 8596 --description "Weather data via AI assistants"
# edit ~/weather-mcp/app/tools/example.py -> real tools
# put creds in ~/weather-mcp/config/.env
systemctl --user enable --now weather-mcp
mcp-health                   # real initialize -> tools/list handshake
```

## What it generates

- `~/<name>-mcp/` — a Python FastMCP project from `skeleton/`:
  - `app/main.py` — FastMCP instance, mounts one router per tool domain
  - `app/config.py` — pydantic-settings, credential resolution that prefers
    `$CREDENTIALS_DIRECTORY` (systemd) and falls back to `config/.env`
  - `app/tools/example.py` — a `*_router` with a `ping` tool to copy
  - `pyproject.toml` with `start = "app.main:main"`, `config/.env(.example)`,
    `secrets/`, `.gitignore`
  - runs `uv sync`
- `~/.config/systemd/user/<name>-mcp.service` — the standardized unit
  (`MCP_TRANSPORT=http`, `ExecStart=<dir>/.venv/bin/start` — native FastMCP
  HTTP; `--stdio` wraps point at the shared supergateway instead), then
  `systemctl --user daemon-reload`.

## Shared supergateway (`--stdio` wraps only)

Wrap units point at one canonical supergateway install
(`~/.local/share/mcp-common/`, overridable with `$MCP_COMMON_DIR`) rather than
each server bundling its own. That keeps every server on the same gateway
version and gives you a single place to upgrade. It's pinned in
`mcp-common/package.json` + `package-lock.json` and reproduced by
`mcp-common/bootstrap.sh` (`npm ci`). To bump: edit the pin, re-run bootstrap.

### Patched: session/child-process leak (supergateway 3.4.3)

`bootstrap.sh` applies `mcp-common/patches/` on top of the pinned install. This
is not optional — unpatched, every unit eventually OOM-kills itself and clients
report *"could not attach to MCP server X"* while the server itself is perfectly
healthy. Upstream 3.4.3 (current latest) leaks one child process per session, for
two independent reasons:

1. **`--sessionTimeout` is not an idle timeout.** `SessionAccessCounter` arms its
   cleanup timer only when the access count reaches exactly 0, and any new access
   clears it. A client holding an SSE stream reconnects every couple of minutes,
   so the timer is armed and disarmed forever and the session never expires. No
   value of `--sessionTimeout` fixes this.
2. **`child.kill()` only kills the shell.** `spawn(cmd, {shell: true})` yields
   `/bin/sh -c ...`; when sh can't exec the command away (e.g. `npx foo` → npm
   exec → sh → node), SIGTERM hits the outer shell and orphans the real server.

The patch reaps sessions idle past `--sessionIdleMs` (default 30m), counting
**only POST requests as activity — never SSE GETs**, kills the child's whole
**process group**, and returns **404** (not 400) for an expired session so
clients re-initialize per the MCP spec. Also tunable: `--sessionMaxAgeMs`
(12h), `--maxSessions` (64), `--sweepIntervalMs` (60s).

`npm ci` reverts the patch, so bootstrap re-applies it every run. `patches/apply.sh`
is pinned to the exact upstream version it was written against and **refuses to run**
if the pin moves — so bumping supergateway fails loudly instead of silently
reintroducing the leak. On a bump: review the patch against the new source, then
update `PATCHED_VERSION` in `patches/apply.sh`.

## Standardized unit defaults

Both modes: bind `0.0.0.0`, `MemorySwapMax=0`, `Restart=always`,
`KillMode=control-group`. Native Python units: `MCP_TRANSPORT=http`,
`MCP_HOST`/`MCP_PORT`, `MemoryMax 512M` (a single process — ample). Wrap
units: `--outputTransport streamableHttp`, `--stateful`, `--sessionTimeout
300000` (5 min), `MemoryMax 1G` — a stateful gateway spawns one child process
per session, so a burst of parallel clients (agent fan-outs) can hold many
live children at once; size the cap for that. Override with
`--session-timeout` / `--memory-max`. `MemorySwapMax=0` matters: without it a
unit that hits its memory cap swap-thrashes (unresponsive but "active")
instead of OOM-killing and restarting cleanly.

## Options

| Flag | Effect |
|------|--------|
| `--description TEXT` | Unit description + server instructions |
| `--dir PATH` | Project dir (default `~/<slug>`) |
| `--stdio CMD` | Skip Python scaffold; wrap an existing/third-party stdio MCP |
| `--tpm-creds` | Add `LoadCredentialEncrypted=` line + sealing instructions |
| `--env-file` | Add `EnvironmentFile=-<dir>/.env` (for node/3rd-party MCPs) |
| `--session-timeout MS` / `--memory-max VAL` | Override unit defaults |
| `--no-sync` | Skip `uv sync` |
| `--enable` | `systemctl --user enable --now` after writing |
| `--force` | Overwrite existing dir/unit |
| `-n`, `--dry-run` | Print the unit + plan, write nothing |

The generator refuses a port already used by another unit (scans
`~/.config/systemd/user/*.service`) unless `--force`.

## TPM-sealed credentials (optional)

On a machine with a TPM, `--tpm-creds` adds a
`LoadCredentialEncrypted=<slug>-secrets:...` line to the unit;
`app/config.py` already prefers `$CREDENTIALS_DIRECTORY/<slug>-secrets`. Seal
real values with:

```bash
systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs="" \
  --name=<slug>-secrets <plaintext-env> ~/<slug>/secrets/<slug>-secrets.cred
```

Keep a copy of the raw values in your password manager — a TPM clear makes the
sealed blob unrecoverable. (Without `--tpm-creds`, credentials just live in
`config/.env`.)

## Wrapping a non-Python / third-party MCP

```bash
new-mcp notion 8597 \
  --stdio "$(command -v node) /path/to/notion-mcp" \
  --env-file --description "Notion MCP"
```

No Python project is scaffolded; only the unit is written. Use `--env-file` so
the wrapped process reads `<dir>/.env`.

## Companion tools

Symlink these onto your PATH alongside `new-mcp`:

```bash
ln -sf ~/mcp-template/mcp-health     ~/.local/bin/mcp-health
ln -sf ~/mcp-template/mcp-seal-creds ~/.local/bin/mcp-seal-creds
ln -sf ~/mcp-template/mcp-guard      ~/.local/bin/mcp-guard
```

**`mcp-health`** — health-checks the whole fleet. Auto-discovers every
`*-mcp.service` unit in `~/.config/systemd/user` (native `MCP_PORT=N` and
gateway `--port N` alike), then does a real client handshake
(`initialize` → `tools/list`) against each and reports active state +
tool count. Exits non-zero if any server fails, so it drops straight into cron
or a status check. `--json` for machine output.

```
SERVICE                PORT   ACTIVE    TOOLS  SERVER                 STATUS
weather-mcp            8596   active    7      weather-mcp            OK
...
9/9 healthy
```

**`mcp-guard`** — safety net for the child-process leak above. Restarts any MCP
unit whose cgroup memory exceeds 75% of its `MemoryMax` (`$MCP_GUARD_THRESHOLD_PCT`),
i.e. catches a leak *before* the OOM killer does. Silent when healthy, so it runs
happily on a timer; `--dry-run` to see what it would do.

```bash
# every 5 min via a systemd user timer (a burst of parallel clients can
# outgrow the cap in well under 15)
systemctl --user enable --now mcp-guard.timer
```

**`mcp-seal-creds`** — TPM2-seals a server's credentials into the
`<slug>-secrets.cred` blob the unit decrypts via `LoadCredentialEncrypted=`
(pairs with `new-mcp --tpm-creds` and the skeleton's `app/config.py`). Plaintext
is staged only in `/dev/shm` and shredded; the sealed blob is safe to keep.

```bash
printf 'WEATHER_API_KEY=...\n' | mcp-seal-creds weather   # or: mcp-seal-creds weather env-file
```

## Layout

```
mcp-template/
  new-mcp                     # the generator (symlink onto your PATH)
  mcp-health                  # fleet health check (initialize -> tools/list sweep)
  mcp-seal-creds              # TPM2-seal a server's credentials blob
  mcp-guard                   # restart units nearing MemoryMax (leak safety net)
  skeleton/                   # the Python project copied + substituted per server
  systemd/mcp.service.example # reference unit with placeholders
  systemd/mcp-guard.{service,timer}
  mcp-common/                 # pinned supergateway: package.json + lockfile + bootstrap.sh
  mcp-common/patches/         # child-process-leak patch, re-applied by bootstrap.sh
```

Placeholders substituted during scaffold: `__MCP_SLUG__` (e.g. `weather-mcp`),
`__MCP_NAME__` (`weather`), `__MCP_ENV_PREFIX__` (`WEATHER_`),
`__MCP_DESCRIPTION__`, `__MCP_PORT__`.

## License

MIT — see [LICENSE](LICENSE).
