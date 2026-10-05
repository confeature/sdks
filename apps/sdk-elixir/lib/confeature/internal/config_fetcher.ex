# SPDX-License-Identifier: MIT

defmodule Confeature.Internal.ConfigFetcher do
  @moduledoc """
  HTTP layer for fetching `config_v6.json` from a Confeature CDN.

  Wraps `HTTPoison` with:
    - User-Agent: `confeature-elixir-sdk/{VERSION}` (FR-012).
    - `If-None-Match` support for 304 reuse (FR-011).
    - Configurable request timeout (default 30 s).
    - SDK key redaction in every log line (FR-013): the raw key is
      NEVER interpolated into messages;
      `Confeature.Internal.SdkKey.redact/1` is the only path.

  The request URL is ConfigCat's `<baseUrl>/configuration-files/<sdkKey>/config_v6.json`,
  built by `config_url/2` alone (#803). The URL therefore carries the SDK
  key, so a failure is reported ONLY as a fixed, key-free reason code —
  never a library message or an inspected response (either may quote the
  URL).

  `result.status` is one of:
    - `:fetched`      — HTTP 200, fresh body + new ETag.
    - `:not_modified` — HTTP 304, caller keeps its cached body.
    - `:failed`       — network error / non-2xx / timeout / refused key.
      `error` is one of the fixed codes `"HTTP <status>"`,
      `"TRANSPORT_TIMEOUT"`, `"TRANSPORT"`, `"MALFORMED_JSON"`,
      `"EXCEPTION"`, `"INVALID_SDK_KEY"` — never the SDK key. An
      `"EXCEPTION"` log line adds the kind — `error:<exception module>`,
      `exit` or `throw` — never the value.

  The key and the URL are held `Confeature.Internal.Sealed`: no
  formatter, crash report or stacktrace argument renders them.
  """

  alias Confeature.Internal.{Options, SdkKey, Sealed}
  alias Confeature.Logger, as: ConfLogger

  @default_base_url "https://cdn-global.confeature.io"

  defmodule Result do
    @moduledoc false
    defstruct status: :failed, body: nil, etag: nil, error: nil

    @type t :: %__MODULE__{
            status: :fetched | :not_modified | :failed,
            body: map() | nil,
            etag: String.t() | nil,
            error: String.t() | nil
          }
  end

  # `sdk_key` and `url` (which carries the key, #803) are sealed, so no
  # renderer quotes them; `inspect/1` omits them as well.
  @derive {Inspect, except: [:sdk_key, :url]}
  defstruct [
    :sdk_key,
    :user_agent,
    :url,
    :timeout_ms,
    :logger,
    :http_client
  ]

  @type t :: %__MODULE__{
          sdk_key: Sealed.t(),
          user_agent: String.t(),
          url: Sealed.t() | nil,
          timeout_ms: pos_integer(),
          logger: ConfLogger.t(),
          http_client: module()
        }

  @doc """
  Build a fetcher value.

  ## Options

    * `:sdk_key` — required; a String or a `Confeature.Internal.Sealed` one.
    * `:version` — required; the SDK version surfaced as User-Agent.
    * `:logger` — required.
    * `:base_url` — defaults to the global Confeature CDN.
    * `:request_timeout_seconds` — float, default 30.0.
    * `:http_client` — module implementing `get/3` (test seam). Default
      `HTTPoison`.
  """
  @spec new(keyword()) :: t()
  def new(opts) do
    sdk_key = opts |> required!(:sdk_key) |> Sealed.unseal()
    version = required!(opts, :version)
    logger = required!(opts, :logger)
    base_url = Keyword.get(opts, :base_url) || @default_base_url
    timeout_s = Keyword.get(opts, :request_timeout_seconds, 30.0)

    if timeout_s <= 0 do
      raise ArgumentError, "request_timeout_seconds must be > 0"
    end

    url =
      case config_url(base_url, sdk_key) do
        {:ok, url} -> Sealed.seal(url)
        :error -> nil
      end

    %__MODULE__{
      sdk_key: Sealed.seal(sdk_key),
      user_agent: "confeature-elixir-sdk/#{version}",
      url: url,
      timeout_ms: trunc(timeout_s * 1000),
      logger: logger,
      http_client: Keyword.get(opts, :http_client, HTTPoison)
    }
  end

  # A missing option, or options that are no keyword list, is a fixed
  # message: the options carry the SDK key (`Confeature.Internal.Options`).
  defp required!(opts, name), do: Options.required!(opts, name, "ConfigFetcher.new/1")

  @doc """
  Build the config URL — the ONE place the SDK's request URL is made (#803).

  Mirrors the `configcat` Hex package (4.0.4,
  `ConfigCat.ConfigFetcher.url/1`): `<baseUrl>/configuration-files/<sdkKey>/config_v6.json`
  with the key's exact bytes.

    * A key matching the shared key shape (`SdkKey.valid_confeature_key_format?/1`,
      tested against `sdk-key-shapes.json`) goes in RAW: split on `/`,
      each part path-segment-escaped (a no-op for a valid key), so a
      `configcat-sdk-1/<22>/<22>` key stays three segments — a stock
      ConfigCat SDK's bytes.
    * Any other key is escaped into ONE segment (like Go's
      `url.PathEscape`). An empty, `.` or `..` key cannot stay inside its
      segment, so it returns `:error` and the fetcher refuses to fetch.
  """
  @spec config_url(String.t(), String.t()) :: {:ok, String.t()} | :error
  def config_url(base_url, sdk_key) when is_binary(base_url) and is_binary(sdk_key) do
    segment = key_path(sdk_key)

    if segment in ["", ".", ".."] do
      :error
    else
      base = String.trim_trailing(base_url, "/")
      {:ok, "#{base}/configuration-files/#{segment}/config_v6.json"}
    end
  end

  def config_url(_base_url, _sdk_key), do: :error

  # The key as it stands in the request path.
  defp key_path(sdk_key) do
    if SdkKey.valid_confeature_key_format?(sdk_key) do
      sdk_key |> String.split("/") |> Enum.map_join("/", &escape_segment/1)
    else
      escape_segment(sdk_key)
    end
  end

  @doc "The request URL the fetcher sends (`nil` when it refuses the key)."
  @spec request_url(t()) :: String.t() | nil
  def request_url(%__MODULE__{url: url}), do: Sealed.unseal(url)

  @doc """
  Every form of the key this fetcher holds — the raw key, its request-path
  form and the request URL — for `SdkKey.scrub/2` (#803).
  """
  @spec secrets(t()) :: [String.t()]
  def secrets(%__MODULE__{sdk_key: sealed_key} = fetcher) do
    case Sealed.unseal(sealed_key) do
      key when is_binary(key) -> [key, key_path(key), request_url(fetcher)]
      _other -> []
    end
    |> Enum.filter(&is_binary/1)
    |> Enum.uniq()
  end

  # Go's `url.PathEscape` (FR-001): keep `A-Z a-z 0-9 - _ . ~` and the six
  # sub-delims `$ & + : = @`; every other byte (UTF-8 included) becomes
  # `%XX`, uppercase hex. `URI.char_unreserved?/1` alone would also escape
  # `$&+:=@` — not Go's bytes.
  defp escape_segment(part), do: URI.encode(part, &path_segment_char?/1)

  defp path_segment_char?(byte), do: URI.char_unreserved?(byte) or byte in ~c"$&+:=@"

  defguardp hex?(c) when c in ?0..?9 or c in ?A..?F or c in ?a..?f

  @doc """
  The request path as it goes on the wire (#803 FR-001).

  hackney re-encodes the path by default (`hackney_url:pathencode/1` turns
  `$` into `%24`, `&` into `%26`, a space into `+`), so the bytes sent
  would not be the ones `config_url/2` built. This encoder, handed to
  hackney as `path_encode_fun`, leaves every legal path byte as is —
  RFC 3986 `pchar` (unreserved, sub-delims `!$&'()*+,;=`, `:`, `@`), `/`
  and a well-formed `%XX` — and escapes any other byte as `%XX` (a raw
  space or a stray `%` in a custom base URL). On `config_url/2`'s output
  it is the identity.
  """
  @spec wire_path(String.t() | nil | :undefined) :: String.t()
  def wire_path(path) when is_binary(path), do: wire_path(path, <<>>)
  def wire_path(_path), do: ""

  defp wire_path(<<>>, acc), do: acc

  defp wire_path(<<?%, h, l, rest::binary>>, acc) when hex?(h) and hex?(l),
    do: wire_path(rest, <<acc::binary, ?%, h, l>>)

  defp wire_path(<<c, rest::binary>>, acc) do
    if URI.char_unreserved?(c) or c in ~c"!$&'()*+,;=:@/" do
      wire_path(rest, <<acc::binary, c>>)
    else
      wire_path(rest, acc <> "%" <> Base.encode16(<<c>>))
    end
  end

  @doc """
  Fetch the config. Never raises — fail-closed. Pass the last-known
  ETag for `If-None-Match`-driven 304 handling.
  """
  @spec fetch(t(), String.t() | nil) :: Result.t()
  def fetch(fetcher, etag \\ nil)

  def fetch(%__MODULE__{url: nil} = fetcher, _etag) do
    log_failure(fetcher, "INVALID_SDK_KEY")
    %Result{status: :failed, error: "INVALID_SDK_KEY"}
  end

  def fetch(%__MODULE__{} = fetcher, etag) do
    headers = build_headers(fetcher.user_agent, etag)

    request_opts = [
      recv_timeout: fetcher.timeout_ms,
      timeout: fetcher.timeout_ms,
      ssl: [verify: :verify_peer, cacerts: :public_key.cacerts_get()],
      hackney: [path_encode_fun: &wire_path/1]
    ]

    case fetcher.http_client.get(request_url(fetcher), headers, request_opts) do
      {:ok, %{status_code: 304} = response} ->
        %Result{status: :not_modified, etag: header(response, "etag")}

      {:ok, %{status_code: code, body: body} = response} when code in 200..299 ->
        parse_success_body(fetcher, body, header(response, "etag"))

      {:ok, %{status_code: code}} when is_integer(code) ->
        fail(fetcher, "HTTP #{code}")

      {:error, %{reason: reason}} ->
        fail(fetcher, transport_error(reason))

      _other ->
        # Never `inspect/1` an unrecognised value: an HTTPoison response
        # or redirect struct carries `request_url`, i.e. the SDK key.
        fail(fetcher, "TRANSPORT")
    end
  rescue
    # The exception message may quote the URL (the key): the result is a
    # fixed code, and the log adds only the exception's module.
    exception -> fail(fetcher, "EXCEPTION", "error:#{inspect(exception.__struct__)}")
  catch
    # An exit or throw value from the HTTP stack may carry the URL as
    # well: only its kind is logged.
    kind, _value -> fail(fetcher, "EXCEPTION", Atom.to_string(kind))
  end

  defp fail(fetcher, code, kind \\ nil) do
    log_failure(fetcher, code, kind)
    %Result{status: :failed, error: code}
  end

  # Classify a transport-layer error reason. Timeout reasons MUST map to
  # the corpus `timeout` class (distinct from a generic `fetchFailed`),
  # mirroring sdk-go's `context_deadline_exceeded -> timeout` split and
  # the wire-cases `timeout` case (#490). Every other transport reason
  # (e.g. `:closed` from a connection dropped mid-response — the
  # `network-reset` case) is a generic `fetchFailed`. Only the fixed code
  # leaves this function — the reason itself is never logged (#803).
  @timeout_reasons [:timeout, :connect_timeout, :recv_timeout, :checkout_timeout]
  defp transport_error(reason) when reason in @timeout_reasons, do: "TRANSPORT_TIMEOUT"
  defp transport_error(_reason), do: "TRANSPORT"

  defp build_headers(user_agent, etag) do
    headers = [{"User-Agent", user_agent}, {"Accept", "application/json"}]
    if is_binary(etag) and etag != "", do: [{"If-None-Match", etag} | headers], else: headers
  end

  defp parse_success_body(fetcher, body, etag) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, decoded} when is_map(decoded) ->
        # Shape validation: a valid `config_v6.json` carries the
        # `{p, f, s}` top-level shape. sdk-node / sdk-python / sdk-go /
        # sdk-ruby tightened the same check so the corpus-wide
        # `wire-cases.json::wrong-shape-200` case surfaces the same
        # `parseFailed` everywhere (epic #146 / issue #148 / spec 112).
        # Probing the `f` key alone is sufficient — it is the only
        # mandatory top-level key in the schema.
        if Map.has_key?(decoded, "f") do
          %Result{status: :fetched, body: decoded, etag: etag}
        else
          log_failure(fetcher, "MALFORMED_JSON")
          %Result{status: :failed, error: "MALFORMED_JSON"}
        end

      {:ok, _} ->
        log_failure(fetcher, "MALFORMED_JSON")
        %Result{status: :failed, error: "MALFORMED_JSON"}

      {:error, _} ->
        log_failure(fetcher, "MALFORMED_JSON")
        %Result{status: :failed, error: "MALFORMED_JSON"}
    end
  end

  defp parse_success_body(fetcher, _body, _etag) do
    log_failure(fetcher, "MALFORMED_JSON")
    %Result{status: :failed, error: "MALFORMED_JSON"}
  end

  defp header(%{headers: headers}, name) when is_list(headers) do
    target = String.downcase(name)

    Enum.find_value(headers, fn {k, v} ->
      if String.downcase(to_string(k)) == target, do: to_string(v)
    end)
  end

  defp header(_response, _name), do: nil

  defp log_failure(%__MODULE__{} = fetcher, reason, kind \\ nil) do
    suffix = if kind, do: " kind=#{kind}", else: ""

    ConfLogger.error(
      fetcher.logger,
      "ConfigFetcher: fetch failed for sdkKey=#{SdkKey.redact(fetcher.sdk_key)} reason=#{reason}" <>
        suffix
    )
  end
end
