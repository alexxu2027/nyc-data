from pathlib import Path

from nyclive.registry import REPO_ROOT
from nyclive.settings import load_settings, read_dotenv


def test_defaults_need_nothing():
    s = load_settings(env={}, dotenv=None)
    assert s.data_dir == REPO_ROOT / "data"
    assert s.state_db == REPO_ROOT / "data" / "state.db"
    assert "github.com" in s.user_agent  # registry default identifies the project
    assert s.socrata_app_token is None
    assert s.host_headers() == {}


def test_env_overrides_and_relative_data_dir(tmp_path):
    s = load_settings(
        env={
            "NYCLIVE_DATA_DIR": "elsewhere",
            "NYCLIVE_USER_AGENT": "me/1",
            "SOCRATA_APP_TOKEN": "t",
        },
        dotenv=None,
    )
    assert s.data_dir == REPO_ROOT / "elsewhere"
    assert s.user_agent == "me/1"
    assert s.host_headers()["data.cityofnewyork.us"] == {"X-App-Token": "t"}

    s = load_settings(env={"NYCLIVE_DATA_DIR": str(tmp_path)}, dotenv=None)
    assert s.data_dir == tmp_path


def test_dotenv_parsing_and_precedence(tmp_path):
    f = tmp_path / ".env"
    f.write_text(
        "# comment\n\nexport SOCRATA_APP_TOKEN='abc'\nNYCLIVE_USER_AGENT=\"from-file\"\n"
        "OPENAQ_API_KEY=\nnot a line\n",
        encoding="utf-8",
    )
    assert read_dotenv(f)["SOCRATA_APP_TOKEN"] == "abc"
    s = load_settings(env={"NYCLIVE_USER_AGENT": "from-env"}, dotenv=f)
    assert s.socrata_app_token == "abc"
    assert s.user_agent == "from-env"  # process env wins
    assert s.openaq_api_key is None  # empty counts as unset
    assert read_dotenv(Path(tmp_path / "missing")) == {}


def test_ensure_dirs(tmp_path):
    s = load_settings(env={"NYCLIVE_DATA_DIR": str(tmp_path / "d")}, dotenv=None)
    s.ensure_dirs()
    assert s.archive_dir.is_dir() and s.logs_dir.is_dir()
