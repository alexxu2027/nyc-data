"""Runtime settings: where data lives, how we identify ourselves, optional keys.

Values come from the process environment, then from a `.env` file at the repo root (see
`.env.example`). Nothing here is required for Phases 1-4.

API keys (ADR-018) never reach adapter code: `host_headers()` and `host_params()` hand them to
`Http`, which attaches them per host and redacts them from every URL it logs or raises.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from nyclive.registry import REPO_ROOT, Source, load_registry

DOTENV = REPO_ROOT / ".env"

# Socrata hosts that accept the optional app token (raises rate limits; same token works on both).
SOCRATA_HOSTS = ("data.cityofnewyork.us", "data.ny.gov")
# Keyed hosts (ADR-018): OpenAQ takes its key as a header, MTA Bus Time as a `key` query param.
OPENAQ_HOST = "api.openaq.org"
BUSTIME_HOST = "gtfsrt.prod.obanyc.com"


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    user_agent: str
    socrata_app_token: str | None = None
    openaq_api_key: str | None = None
    mta_bustime_key: str | None = None
    ny511_api_key: str | None = None

    def key(self, env_name: str) -> str | None:
        """The value of a registry `auth: key:<ENV_VAR>`, or None if it isn't set."""
        return {
            "OPENAQ_API_KEY": self.openaq_api_key,
            "MTA_BUSTIME_KEY": self.mta_bustime_key,
            "NY511_API_KEY": self.ny511_api_key,
            "SOCRATA_APP_TOKEN": self.socrata_app_token,
        }.get(env_name)

    def has_key_for(self, src: Source) -> bool:
        """True if the source is keyless or its key is set."""
        return src.key_env is None or self.key(src.key_env) is not None

    def secrets(self) -> tuple[str, ...]:
        """Every key value that is set, for redaction."""
        vals = (
            self.socrata_app_token,
            self.openaq_api_key,
            self.mta_bustime_key,
            self.ny511_api_key,
        )
        return tuple(v for v in vals if v)

    @property
    def state_db(self) -> Path:
        return self.data_dir / "state.db"

    @property
    def archive_dir(self) -> Path:
        return self.data_dir / "archive"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def probe_dir(self) -> Path:
        return self.data_dir / "probe"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.archive_dir, self.images_dir, self.probe_dir, self.logs_dir):
            d.mkdir(parents=True, exist_ok=True)

    def host_headers(self) -> dict[str, dict[str, str]]:
        """Extra headers per host, for `Http(host_headers=...)`."""
        out: dict[str, dict[str, str]] = {}
        if self.socrata_app_token:
            out.update({h: {"X-App-Token": self.socrata_app_token} for h in SOCRATA_HOSTS})
        if self.openaq_api_key:
            out[OPENAQ_HOST] = {"X-API-Key": self.openaq_api_key}
        return out

    def host_params(self) -> dict[str, dict[str, str]]:
        """Extra query params per host, for `Http(host_params=...)`."""
        return {BUSTIME_HOST: {"key": self.mta_bustime_key}} if self.mta_bustime_key else {}

    def http_kwargs(self) -> dict:
        """Everything `Http(...)` needs from settings besides the user agent."""
        return {
            "host_headers": self.host_headers(),
            "host_params": self.host_params(),
            "secrets": self.secrets(),
        }


def read_dotenv(path: Path = DOTENV) -> dict[str, str]:
    """Minimal KEY=VALUE parser: comments, blank lines, optional quotes. No interpolation."""
    if not path.is_file():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        out[key] = value
    return out


def load_settings(
    env: Mapping[str, str] | None = None,
    dotenv: Path | None = DOTENV,
    default_user_agent: str | None = None,
) -> Settings:
    """Build Settings. The process env wins over `.env`; empty values count as unset."""
    merged = dict(read_dotenv(dotenv)) if dotenv else {}
    merged.update(os.environ if env is None else env)

    def get(key: str) -> str | None:
        v = merged.get(key, "").strip()
        return v or None

    data_dir = Path(get("NYCLIVE_DATA_DIR") or "data").expanduser()
    if not data_dir.is_absolute():
        data_dir = REPO_ROOT / data_dir

    ua = get("NYCLIVE_USER_AGENT") or default_user_agent or load_registry().user_agent
    return Settings(
        data_dir=data_dir,
        user_agent=ua,
        socrata_app_token=get("SOCRATA_APP_TOKEN"),
        openaq_api_key=get("OPENAQ_API_KEY"),
        mta_bustime_key=get("MTA_BUSTIME_KEY"),
        ny511_api_key=get("NY511_API_KEY"),
    )
