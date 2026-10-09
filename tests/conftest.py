import os

os.environ["DATABASE_URL"] = "sqlite://"

import pytest
from sqlalchemy.orm import sessionmaker

from genomeos.db import Base, make_engine


@pytest.fixture()
def db_session():
    engine = make_engine("sqlite://")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        yield session


@pytest.fixture(scope="session")
def _blocked_gcloud(tmp_path_factory: pytest.TempPathFactory):
    shim = tmp_path_factory.mktemp("gcloud-blocked") / "gcloud"
    shim.write_text(
        "#!/bin/sh\n"
        'echo "tests may not run the real gcloud; use tests.atlas_web_fixtures.install_fake_gcloud" >&2\n'
        "exit 97\n",
        encoding="utf-8",
    )
    shim.chmod(0o755)
    return shim


@pytest.fixture(autouse=True)
def _no_real_gcloud(monkeypatch: pytest.MonkeyPatch, _blocked_gcloud):
    """Design 2026-10-07 §C.3: bucket-script tests use the fake gcloud only.

    scripts/gcloud_repo.py falls back to the real ``gcloud`` with the repository-local credentials;
    this points GENOMEOS_GCLOUD_EXECUTABLE at a shim that exits 97 unless a test installs the fake
    (``install_fake_gcloud`` sets the variable again, which wins).
    """
    monkeypatch.setenv("GENOMEOS_GCLOUD_EXECUTABLE", str(_blocked_gcloud))
