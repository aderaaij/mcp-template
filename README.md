# mcp-template — boilerplate for self-hosted MCP servers

A small generator for spinning up [Model Context Protocol](https://modelcontextprotocol.io)
servers that all share one shape: a `systemctl --user` unit that runs
[**supergateway**](https://github.com/supercorp-ai/supergateway), wrapping a
**stdio** MCP and exposing it as **streamable HTTP** on a local port. Python
servers additionally share an `app/main.py` + `app/config.py` +
`app/tools/<domain>.py` layout built on [FastMCP](https://github.com/jlowin/fastmcp).

`new-mcp` factors that out so a new server is "write the tools", not
"copy-paste an existing one and find-replace".

> The generated server binds `0.0.0.0` — put it behind your own LAN, VPN,
> Tailscale, or reverse proxy; it does no auth of its own.

## Requirements

- `node` + `npm` (runs supergateway)
- [`uv`](https://github.com/astral-sh/uv) (Python project + deps), for Python servers
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
curl -s localhost:8596/      # supergateway is up
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
- `~/.config/systemd/user/<name>-mcp.service` — the standardized unit, pointing
  at the shared supergateway, then `systemctl --user daemon-reload`.

## Shared supergateway

All generated units point at one canonical supergateway install
(`~/.local/share/mcp-common/`, overridable with `$MCP_COMMON_DIR`) rather than
each server bundling its own. That keeps every server on the same gateway
version and gives you a single place to upgrade. It's pinned in
`mcp-common/package.json` + `package-lock.json` and reproduced by
`mcp-common/bootstrap.sh` (`npm ci`). To bump: edit the pin, re-run bootstrap.

## Standardized unit defaults

`--port`, `--host 0.0.0.0`, `--outputTransport streamableHttp`, `--stateful`,
`--sessionTimeout 300000` (5 min), `MemoryMax 256M`, `Restart=always`,
`KillMode=control-group`. Override with `--session-timeout` / `--memory-max`.

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

## Layout

```
mcp-template/
  new-mcp                     # the generator (symlink onto your PATH)
  skeleton/                   # the Python project copied + substituted per server
  systemd/mcp.service.example # reference unit with placeholders
  mcp-common/                 # pinned supergateway: package.json + lockfile + bootstrap.sh
```

Placeholders substituted during scaffold: `__MCP_SLUG__` (e.g. `weather-mcp`),
`__MCP_NAME__` (`weather`), `__MCP_ENV_PREFIX__` (`WEATHER_`),
`__MCP_DESCRIPTION__`.

## License

MIT — see [LICENSE](LICENSE).
