# SPDX-License-Identifier: MIT
"""Verify the installed wheel and its opt-in dependency under Python 3.10."""

import sys
from importlib import metadata, util
from pathlib import Path
from tempfile import TemporaryDirectory

from fixture import TARGETED_FLAG, guarded_http

import confeature_client
from confeature_client import ConfeatureClient, ManualPoll, User


def assert_install(extra: bool) -> None:
    assert sys.version_info[:2] == (3, 10)
    wheel = metadata.distribution("confeature-client")
    assert wheel.version == confeature_client.__version__ == "0.2.0"
    assert (
        Path(confeature_client.__file__).resolve()
        == wheel.locate_file("confeature_client/__init__.py").resolve()
    )
    assert "openfeature" in (wheel.metadata.get_all("Provides-Extra") or [])
    assert "openfeature" not in sys.modules
    assert "ConfeatureProvider" not in confeature_client.__all__
    assert {r for r in (wheel.requires or []) if ";" not in r} == {
        "httpx>=0.27",
        "platformdirs>=4",
    }
    assert any(
        r.split(";")[0].strip() == "openfeature-sdk==0.10.0" and "openfeature" in r.split(";")[-1]
        for r in (wheel.requires or [])
    )
    if extra:
        assert metadata.version("openfeature-sdk") == "0.10.0"
    else:
        assert util.find_spec("openfeature") is None


def check_extra(client: ConfeatureClient) -> None:
    # The base-wheel probe runs in an environment without these optional modules.
    from openfeature.evaluation_context import EvaluationContext  # noqa: PLC0415

    from confeature_client.openfeature import ConfeatureProvider  # noqa: PLC0415
    from openfeature import api  # noqa: PLC0415

    api.set_provider_and_wait(ConfeatureProvider(client), domain="installed-wheel")
    try:
        official = api.get_client(domain="installed-wheel")
        admin = official.get_string_details(
            TARGETED_FLAG, "default", EvaluationContext("synthetic", {"Custom1": "admin"})
        )
        visitor = official.get_string_details(TARGETED_FLAG, "default")
        assert (admin.value, admin.variant, admin.error_code) == ("Dog", "5b64d9b4", None)
        assert (visitor.value, visitor.variant, visitor.error_code) == ("Cat", "83372510", None)
    finally:
        api.clear_providers()


def main() -> None:
    if not __debug__:
        raise SystemExit("Run the wheel probe with Python assertions enabled.")
    if sys.argv[1:] not in (["base"], ["extra"]):
        raise SystemExit("Use the seeded runner with wheel_probe.py base or wheel_probe.py extra.")
    extra = sys.argv[1] == "extra"
    assert_install(extra)
    with guarded_http() as guard, TemporaryDirectory() as cache:
        served = guard.served()
        with ConfeatureClient(
            guard.key, ManualPoll(), base_url=guard.origin, cache_dir=cache
        ) as client:
            assert client.force_refresh().success
            if extra:
                check_extra(client)
            assert (
                client.get_value_details(
                    TARGETED_FLAG, None, User("synthetic", custom={"Custom1": "admin"})
                ).value
                == "Dog"
            )
        assert (guard.count, guard.served() - served, guard.blocked) == (1, 1, 0)
    print(f"Python 3.10 installed wheel: {sys.argv[1]} fixture passed")


if __name__ == "__main__":
    main()
