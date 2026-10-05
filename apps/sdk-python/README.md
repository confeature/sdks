# confeature-client (Python)

Python SDK for [Confeature](https://confeature.io) — a drop-in replacement
for ConfigCat's official `configcat-client` Python SDK. Migrate by
changing the import name and the SDK key value; no code changes needed.

## Install

```bash
# Using uv (recommended)
uv add confeature-client

# Using pip
pip install confeature-client
```

> PyPI publish is deferred to a future release; for now, build the wheel
> from this repository (`uv build` in `apps/sdk-python/`) and install
> via `pip install dist/confeature_client-*.whl`.

Requires Python 3.10+.

## Quickstart

```python
from confeature_client import ConfeatureClient, User

with ConfeatureClient(sdk_key="configcat-sdk-1/...") as client:
    user = User(identifier="alice@example.com")
    enabled = client.get_value("feature.dark-mode", default=False, user=user)
    print(f"dark mode: {enabled}")
```

## Polling modes

Mirrors `configcat-client`: pick one of `AutoPoll()` (default, daemon
thread polls every 60s), `LazyLoad()` (fetch on first stale read), or
`ManualPoll()` (only on explicit `client.force_refresh()`).

```python
from confeature_client import ConfeatureClient, ManualPoll

client = ConfeatureClient(sdk_key="...", polling_mode=ManualPoll())
client.force_refresh()
```

## Flag overrides

Use `FlagOverrides(MapOverrideDataSource({...}), OverrideBehaviour.LOCAL_ONLY)`
to bypass the network entirely (tests, local dev):

```python
from confeature_client import (
    ConfeatureClient,
    FlagOverrides,
    MapOverrideDataSource,
    OverrideBehaviour,
)

client = ConfeatureClient(
    sdk_key="...",
    flag_overrides=FlagOverrides(
        data_source=MapOverrideDataSource({"feature.x": True}),
        behaviour=OverrideBehaviour.LOCAL_ONLY,
    ),
)
assert client.get_value("feature.x", default=False) is True
```

`LOCAL_OVER_REMOTE` and `REMOTE_OVER_LOCAL` are accepted at the type
level but raise `NotImplementedError` at evaluation time (deferred per
the parent monorepo's spec 031 §R8).

## Migrate from ConfigCat

```diff
- import configcatclient
+ from confeature_client import ConfeatureClient
- client = configcatclient.create_client("YOUR-CONFIGCAT-KEY")
+ client = ConfeatureClient(sdk_key="YOUR-CONFEATURE-KEY")
```

Confeature SDK keys have ConfigCat's own shape, `configcat-sdk-1/<22>/<22>`,
so a key copied from the Confeature dashboard also works in the stock
`configcat-client`. Keys minted before that, `confeature-sdk-1-<32>-<32>`,
are still accepted (`is_valid_confeature_key_format` checks both).

Method signatures, polling options, flag-overrides semantics, and User
field names all mirror `configcat-client`. The corpus parity tier
(`tests/parity/test_parity_corpus.py`) gates byte-identical output across
58 (flag, user, default) tuples.

## Documentation & support

- Docs: [confeature.io/docs/sdk/python](https://confeature.io/docs/sdk/python)
- Issue tracker: <https://github.com/confeature/sdks/issues>
- Source: [`apps/sdk-python/`](./) in the `confeature/sdks` repository.

## License

MIT. See `LICENSE` at the package root.
