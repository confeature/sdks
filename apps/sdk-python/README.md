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

Requires Python 3.10+.

## Quickstart

```python
from confeature_client import ConfeatureClient, User

with ConfeatureClient(sdk_key="configcat-sdk-1/...") as client:
    user = User(identifier="alice@example.com")
    enabled = client.get_value("feature.dark-mode", default=False, user=user)
    print(f"dark mode: {enabled}")
```

## OpenFeature

Install the extra on Python 3.10 or later.

```bash
pip install 'confeature-client[openfeature]'
```

Register the provider with the official OpenFeature SDK. Pass a Confeature
client configured without a default user.

```python
from confeature_client import ConfeatureClient
from confeature_client.openfeature import ConfeatureProvider
from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from openfeature.provider.no_op_provider import NoOpProvider

with ConfeatureClient(sdk_key="YOUR-CONFEATURE-KEY") as sdk:
    api.set_provider_and_wait(ConfeatureProvider(sdk), domain="app")
    try:
        client = api.get_client(domain="app")
        context = EvaluationContext("user-123", {"Country": "FR", "Plan": "pro"})
        enabled = client.get_boolean_value("feature.dark-mode", False, context)
    finally:
        api.set_provider_and_wait(NoOpProvider(), domain="app")
```

Registration completes without fetching or waiting for flag data. The
example resets only the `app` provider when evaluation finishes. The
application owns the Confeature client and closes it at the end of the block.
AutoPoll, LazyLoad and ManualPoll keep their SDK behavior.
A cold cache with no data returns the caller's default with
`PROVIDER_NOT_READY` until polling or a caller refresh loads a config. Async
scalar evaluations run on a worker thread so a LazyLoad refresh leaves the
event loop available.

The OpenFeature 0.10.0 async client can raise `UnboundLocalError` if a task is
cancelled during evaluation. If your application needs standard cancellation,
use `await asyncio.to_thread(client.get_boolean_value, key, default, context)`
with the synchronous OpenFeature client method. Started work can still finish
after cancellation. Let it finish before closing the Confeature client.

The provider maps the OpenFeature targeting key to the Confeature user
identifier. Use `Email` and `Country` for the corresponding SDK attributes.
Other supported scalar, datetime and string-array attributes are copied into
the user's custom attributes. Boolean, string, integer and finite float results
use exact types and include the SDK variation ID when available. An unknown flag
returns `FLAG_NOT_FOUND`. Incompatible types and object evaluations return
`TYPE_MISMATCH`.

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
