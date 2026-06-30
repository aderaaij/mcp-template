"""Configuration for the __MCP_NAME__ MCP server.

Credentials/config are read from the env file (or process environment) with the
`__MCP_ENV_PREFIX__` prefix. Resolution order:

  1. Under systemd with TPM-sealed creds, the decrypted file is exposed at
     $CREDENTIALS_DIRECTORY/<credential-name> (tmpfs). Preferred.
  2. Otherwise the plaintext `config/.env` next to this project (local/dev,
     or non-TPM systemd runs).

This mirrors the pattern used by the other ardencore MCP servers. To TPM-seal:
  systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs="" \
    --name=__MCP_SLUG__-secrets <plaintext-env> secrets/__MCP_SLUG__-secrets.cred
and add `LoadCredentialEncrypted=__MCP_SLUG__-secrets:.../secrets/__MCP_SLUG__-secrets.cred`
to the unit (the generator does this for you with --tpm-creds).
"""

import os
import sys
from pathlib import Path

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

# Must match the `--name=` used when sealing and the LoadCredentialEncrypted key.
_CREDENTIAL_NAME = "__MCP_SLUG__-secrets"


def _resolve_env_file() -> Path:
    creds_dir = os.environ.get("CREDENTIALS_DIRECTORY")
    if creds_dir:
        sealed = Path(creds_dir) / _CREDENTIAL_NAME
        if sealed.exists():
            return sealed
    return Path(__file__).parent.parent / "config" / ".env"


class Settings(BaseSettings):
    """Loaded from the env file / process env with the `__MCP_ENV_PREFIX__` prefix."""

    model_config = SettingsConfigDict(
        env_file=str(_resolve_env_file()),
        env_file_encoding="utf-8",
        env_prefix="__MCP_ENV_PREFIX__",
        extra="ignore",
    )

    # --- Add your credential / config fields here, e.g.: ---
    # api_key: SecretStr = Field(default=SecretStr(""), description="...")

    log_level: str = Field(default="INFO", description="Logging level")

    def is_configured(self) -> bool:
        """Whether the minimum required credentials are present.

        Replace the body with a real check once you add credential fields,
        e.g. `return bool(self.api_key.get_secret_value())`.
        """
        return True


try:
    settings = Settings()
    if not settings.is_configured():
        print(
            "Warning: required __MCP_ENV_PREFIX__* settings are not set. "
            f"Expected env file at: {Settings.model_config.get('env_file')}",
            file=sys.stderr,
        )
except ValidationError as e:
    print(f"Configuration error: {e}", file=sys.stderr)
    settings = Settings.model_construct()
