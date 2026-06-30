# mcp-template — boilerplate for ardencore MCP servers

Every MCP gateway on ardencore has the same shape: a `systemctl --user` unit that
runs **supergateway**, wrapping a **stdio** MCP and exposing it as
**streamableHTTP** on a Tailscale-bound port. The Python servers (degiro,
training, open-wearables, finance) additionally share an `app/main.py` +
`app/config.py` + `app/tools/<domain>.py` layout.

This package factors that out so a new server is "write the tools", not
"copy-paste degiro and find-replace".

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
  - `app/config.py` — pydantic-settings, TPM-aware env resolution (prefers
    `$CREDENTIALS_DIRECTORY`, falls back to `config/.env`)
  - `app/tools/example.py` — a `*_router` with a `ping` tool to copy
  - `pyproject.toml` with `start = "app.main:main"`, `config/.env(.example)`,
    `secrets/`, `.gitignore`
  - runs `uv sync`
- `~/.config/systemd/user/<name>-mcp.service` — the standardized unit, pointing
  at the **shared** supergateway (`~/.local/share/mcp-common/`), then
  `systemctl --user daemon-reload`.

## Why a shared supergateway

Before this template, every Python service's `ExecStart` reached into
`~/.local/share/todoist-mcp/node_modules/.bin/supergateway` — so all servers
secretly depended on the todoist install. The generator points new units at the
canonical `~/.local/share/mcp-common/node_modules/.bin/supergateway` instead.
Update it in one place: `cd ~/.local/share/mcp-common && npm update` (then bump
the pin in `mcp-common/package.json` here and re-run bootstrap).

## Bootstrap on a fresh machine

The shared supergateway install is reproducible from the pinned lockfile in
`mcp-common/`:

```bash
git clone git@github.com:aderaaij/mcp-template.git ~/mcp-template
~/mcp-template/mcp-common/bootstrap.sh          # -> ~/.local/share/mcp-common (npm ci)
ln -sf ~/mcp-template/new-mcp ~/.local/bin/new-mcp
```

supergateway is pinned to a specific version (currently 3.4.3) so every server
built this way runs the same gateway.

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

## TPM-sealed credentials

With `--tpm-creds` the unit gets a `LoadCredentialEncrypted=<slug>-secrets:...`
line; `app/config.py` already prefers `$CREDENTIALS_DIRECTORY/<slug>-secrets`.
Seal real values with:

```bash
systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs="" \
  --name=<slug>-secrets <plaintext-env> ~/<slug>/secrets/<slug>-secrets.cred
```

Keep a copy of the raw values off-TPM (1Password) — a TPM clear makes the blob
unrecoverable. (Same pattern as the DeGiro MCP; see `~/CLAUDE.md`.)

## Wrapping a non-Python / third-party MCP

```bash
new-mcp notion 8597 \
  --stdio '/home/arden/.nvm/versions/node/v24.6.0/bin/node /path/to/notion-mcp' \
  --env-file --description "Notion MCP"
```

No Python project is scaffolded; only the unit is written. Use `--env-file` so
the wrapped process reads `<dir>/.env`.

## After creating a server

Update `~/CLAUDE.md` (Containers/Services + Key Ports tables) and run
`server-inventory` — that's the house convention for tracking what runs where.

## Layout

```
mcp-template/
  new-mcp                     # the generator (symlinked to ~/.local/bin/new-mcp)
  skeleton/                   # the Python project copied + substituted per server
  systemd/mcp.service.example # reference unit with placeholders
  README.md
```

Placeholders substituted during scaffold: `__MCP_SLUG__` (e.g. `weather-mcp`),
`__MCP_NAME__` (`weather`), `__MCP_ENV_PREFIX__` (`WEATHER_`),
`__MCP_DESCRIPTION__`.
