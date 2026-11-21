// SPDX-License-Identifier: MIT
package io.confeature.openfeature;

import static io.confeature.openfeature.OpenFeatureSmoke.nativeClient;
import static io.confeature.openfeature.OpenFeatureSmoke.same;

import com.sun.net.httpserver.HttpServer;
import io.confeature.client.PollingMode;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.SocketTimeoutException;

final class TransportSmoke {
  private TransportSmoke() {}

  static void check(String key) throws Exception {
    rejectMissingOrigin();
    final var loopback = InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
    final var redirect = HttpServer.create(new InetSocketAddress(loopback, 0), 0);
    try (var canary = new ServerSocket(0, 10, loopback)) {
      final int redirectPort = redirect.getAddress().getPort();
      final String allowed = "http://127.0.0.1:" + redirectPort;
      redirect.createContext(
          "/",
          exchange -> {
            exchange
                .getResponseHeaders()
                .set("Location", "http://127.0.0.1:" + canary.getLocalPort() + "/blocked");
            try {
              exchange.sendResponseHeaders(302, -1);
            } finally {
              exchange.close();
            }
          });
      redirect.start();
      try (var guard = new LoopbackOnly(LoopbackOnly.requireOrigin(allowed))) {
        expectFailedRefresh(allowed, key);
        expectFailedRefresh("http://localhost:" + redirectPort, key);
        expectFailedRefresh("https://127.0.0.1:" + redirectPort, key);
        same(3, guard.deniedCount(), "redirect, host and scheme denials before socket IO");
      }
      canary.setSoTimeout(200);
      try (var connection = canary.accept()) {
        throw new AssertionError("unexpected fixture canary connection");
      } catch (SocketTimeoutException expected) {
        System.out.println("Java fixture canary received zero destination connections");
      }
    } finally {
      redirect.stop(0);
    }
  }

  private static void rejectMissingOrigin() {
    try {
      LoopbackOnly.requireOrigin(null);
      throw new AssertionError("a missing fixture origin must fail before SDK construction");
    } catch (IllegalArgumentException expected) {
      // The SDK never sees an absent origin that it could replace with a default CDN URL.
    }
  }

  private static void expectFailedRefresh(String origin, String key) {
    try (var client = nativeClient(origin, key, PollingMode.manualPoll())) {
      same(false, client.forceRefresh(), "transport rejected the attempted origin");
    }
  }
}
