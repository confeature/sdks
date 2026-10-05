# SPDX-License-Identifier: MIT
"""Integration test: build the wheel + install it into a fresh venv + import.

Marked `@pytest.mark.slow` and skipped by default (the workspace pytest
config selects it only when `-m slow` is passed, but `conftest` /
pyproject markers leave it collected). CI opts in via `pytest -m slow`.

The test exercises the full distribution path the customer will use:
  1. `uv build` — produces dist/confeature_client-*.whl + .tar.gz.
  2. `uv venv` — creates an isolated tmp virtualenv.
  3. `uv pip install dist/*.whl` — installs into the tmp venv.
  4. `python -c "from confeature_client import ConfeatureClient, __version__; print(__version__)"`
     — must exit 0 with a non-empty version on stdout.

Skips when `uv` is not on PATH (local dev without uv installed).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SDK_ROOT = Path(__file__).resolve().parents[2]


def _have_uv() -> bool:
    return shutil.which("uv") is not None


pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(not _have_uv(), reason="uv not on PATH"),
]


def _venv_python(venv_dir: Path) -> Path:
    """Return the python executable inside `venv_dir`."""
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _run(
    cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd is not None else None,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_wheel_builds_installs_and_imports(tmp_path: Path) -> None:
    """End-to-end wheel gate (SC-007 + SC-008 of spec 037)."""
    # 1. Build a fresh wheel + sdist into a tmp dist dir so we don't
    #    perturb the repo's own dist/.
    dist_dir = tmp_path / "dist"
    build_result = _run(["uv", "build", "--out-dir", str(dist_dir)], cwd=SDK_ROOT)
    assert build_result.returncode == 0, (
        f"uv build failed:\nstdout={build_result.stdout!r}\nstderr={build_result.stderr!r}"
    )
    wheels = list(dist_dir.glob("confeature_client-*.whl"))
    assert len(wheels) == 1, f"Expected exactly one wheel, got {wheels!r}"
    sdists = list(dist_dir.glob("confeature_client-*.tar.gz"))
    assert len(sdists) == 1, f"Expected exactly one sdist, got {sdists!r}"
    wheel_path = wheels[0]

    # 2. Create an isolated tmp venv.
    venv_dir = tmp_path / "venv"
    venv_result = _run(["uv", "venv", str(venv_dir)])
    assert venv_result.returncode == 0, f"uv venv failed: stderr={venv_result.stderr!r}"

    # 3. Install the freshly-built wheel into that venv.
    env = os.environ.copy()
    env["VIRTUAL_ENV"] = str(venv_dir)
    install_result = _run(["uv", "pip", "install", str(wheel_path)], env=env)
    assert install_result.returncode == 0, (
        f"uv pip install failed: stderr={install_result.stderr!r}"
    )

    # 4. Import the package + read __version__ from the installed copy.
    venv_python = _venv_python(venv_dir)
    assert venv_python.exists(), f"venv python missing: {venv_python}"
    import_result = _run(
        [
            str(venv_python),
            "-c",
            "from confeature_client import ConfeatureClient, __version__; print(__version__)",
        ]
    )
    assert import_result.returncode == 0, f"Import failed: stderr={import_result.stderr!r}"
    printed_version = import_result.stdout.strip()
    assert printed_version, "Expected a non-empty __version__"
    # Sanity: matches a semver-ish shape (digit.digit.digit prefix).
    assert printed_version[0].isdigit(), f"Expected semver-ish __version__, got {printed_version!r}"
