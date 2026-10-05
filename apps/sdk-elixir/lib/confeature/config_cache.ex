# SPDX-License-Identifier: MIT

defmodule Confeature.ConfigCache do
  @moduledoc """
  Pluggable cache behaviour for the latest `config_v6.json` body + ETag.

  Implementations MUST be safe to call from multiple processes.
  Two ship-with implementations live under `Confeature.Internal.*`:
    - `Confeature.Internal.InMemoryCache` — process-local, ephemeral.
    - `Confeature.Internal.FilesystemCache` — JSON-on-disk, with an
      in-memory fallback when the cache dir is unwritable.

  Cache entries are plain maps with three string-keyed fields so the
  on-disk JSON shape is stable:

      %{"body" => map(), "etag" => String.t() | nil, "fetched_at" => float()}

  Behaviour callbacks: `read/0` and `write/1`. Concrete implementations
  may carry state via a struct + module-level functions; the GenServer
  client wraps the cache in `Confeature.Internal.CacheRef` so callers
  always work against the same in-memory entry under contention.
  """

  @type entry :: %{
          optional(:body) => map(),
          optional(:etag) => String.t() | nil,
          optional(:fetched_at) => float()
        }

  @callback read(any()) :: entry() | nil
  @callback write(any(), entry()) :: :ok
end
