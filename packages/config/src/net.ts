import net from 'node:net';

/**
 * Turn on Happy Eyeballs (RFC 8305) for outbound connections.
 *
 * Both KeeperHub and the public RPC providers are dual-stack. On a host whose
 * IPv6 route is broken — common on home and mobile networks, and silent because
 * everything else falls back — Node opens the AAAA address and waits out the
 * full connect timeout before trying IPv4. `curl` masks this by racing the two
 * families, so the same endpoint looks healthy from the shell and times out
 * from the application.
 *
 * The failure is worth naming because of how it presents here: the executor
 * call surfaces as `fetch failed`, and the observer quietly loses providers and
 * drops below quorum. Both look like the other party being unreliable, and
 * neither is.
 *
 * Enabling family autoselection races A and AAAA and keeps whichever connects,
 * so a dead IPv6 path costs milliseconds instead of a timeout.
 */
export function enableDualStackFallback(): void {
  // Guarded: the API exists from Node 18.13, and is already the default on some
  // newer releases. Calling it twice is harmless.
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(true);
  }
}
