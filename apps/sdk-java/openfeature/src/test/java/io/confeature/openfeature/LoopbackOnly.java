// SPDX-License-Identifier: MIT
package io.confeature.openfeature;

import java.io.IOException;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.URI;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

final class LoopbackOnly extends ProxySelector implements AutoCloseable {
  private final URI origin;
  private final ProxySelector previous;
  private final AtomicInteger denied = new AtomicInteger();

  LoopbackOnly(URI origin) {
    this.origin = origin;
    this.previous = ProxySelector.getDefault();
    ProxySelector.setDefault(this);
  }

  static URI requireOrigin(String value) {
    if (value == null || !value.matches("http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}")) {
      throw new IllegalArgumentException("An ephemeral loopback fixture origin is required.");
    }
    final URI origin = URI.create(value);
    if (origin.getPort() > 65535) {
      throw new IllegalArgumentException("The fixture port is out of range.");
    }
    return origin;
  }

  @Override
  public List<Proxy> select(URI uri) {
    final String scheme = uri.getScheme();
    // OkHttp asks for HTTP routes. The JDK asks again when creating a direct socket.
    if (("http".equals(scheme) || "socket".equals(scheme))
        && origin.getHost().equals(uri.getHost())
        && origin.getPort() == uri.getPort()
        && uri.getUserInfo() == null) {
      return List.of(Proxy.NO_PROXY);
    }
    denied.incrementAndGet();
    throw new SecurityException("A request left the loopback fixture origin.");
  }

  int deniedCount() {
    return denied.get();
  }

  @Override
  public void connectFailed(URI uri, SocketAddress address, IOException error) {}

  @Override
  public void close() {
    ProxySelector.setDefault(previous);
  }
}
