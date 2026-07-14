/**
 * Bind-target classification for the HTTP transport.
 *
 * Pure, side-effect-free helpers used to decide whether a configured bind
 * host is "loopback" (local-only, e.g. VS Code / localhost workflows) or
 * "remote" (anything reachable from outside the current machine: wildcard
 * binds, LAN/public IPs, and arbitrary hostnames).
 *
 * Remote binds must never open a listening socket without a ready,
 * non-empty authentication policy. See S1 in the remediation plan.
 */
import net from 'node:net';

export type BindHostClass = 'loopback' | 'remote';

const LOOPBACK_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::0', '*']);

function stripIPv6Brackets(host: string): string {
    if (host.startsWith('[') && host.endsWith(']')) {
        return host.slice(1, -1);
    }
    return host;
}

function isLoopbackIPv4(host: string): boolean {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) {
        return false;
    }
    const octets = match.slice(1, 5).map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
        return false;
    }
    // The entire 127.0.0.0/8 block is loopback, not just 127.0.0.1.
    return octets[0] === 127;
}

function isLoopbackIPv6(host: string): boolean {
    const normalized = host.toLowerCase();
    if (normalized === '::1') {
        return true;
    }
    const mapped = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped?.[1]) {
        return isLoopbackIPv4(mapped[1]);
    }
    return false;
}

/**
 * Classify a configured bind host as "loopback" or "remote".
 *
 * - Loopback: `127.0.0.1` (and the rest of 127.0.0.0/8), `::1`, `localhost`,
 *   and their bracketed/mapped equivalents.
 * - Remote: everything else, including wildcard binds (`0.0.0.0`, `::`, `*`),
 *   an empty/unspecified host (binds all interfaces), LAN/public IPv4/IPv6
 *   addresses, and arbitrary hostnames.
 */
export function classifyBindHost(rawHost: string | null | undefined): BindHostClass {
    const trimmed = (rawHost ?? '').trim();
    if (trimmed === '') {
        // An empty host binds the unspecified address (all interfaces) - treat
        // as remote so it never silently opens an unauthenticated socket.
        return 'remote';
    }

    const host = stripIPv6Brackets(trimmed).toLowerCase();

    if (WILDCARD_HOSTS.has(host)) {
        return 'remote';
    }

    if (LOOPBACK_HOSTNAMES.has(host)) {
        return 'loopback';
    }

    if (net.isIPv4(host)) {
        return isLoopbackIPv4(host) ? 'loopback' : 'remote';
    }

    if (net.isIPv6(host)) {
        return isLoopbackIPv6(host) ? 'loopback' : 'remote';
    }

    // Arbitrary hostname (not "localhost") - conservatively treat as remote.
    return 'remote';
}

export function isLoopbackBindHost(rawHost: string | null | undefined): boolean {
    return classifyBindHost(rawHost) === 'loopback';
}

export function isRemoteBindHost(rawHost: string | null | undefined): boolean {
    return classifyBindHost(rawHost) === 'remote';
}

export class InsecureRemoteBindError extends Error {
    constructor(host: string) {
        super(
            `Refusing to bind HTTP server to non-loopback host "${host}" without a ready authentication ` +
            'policy. Set CONTEXT_ENGINE_HTTP_AUTH_ENABLED=true and configure at least one non-empty token ' +
            'via CONTEXT_ENGINE_HTTP_AUTH_TOKENS, or bind to a loopback address (127.0.0.1, ::1, localhost).'
        );
        this.name = 'InsecureRemoteBindError';
    }
}

/**
 * Guard called before `server.listen(...)`. Must never allow a remote
 * (non-loopback) bind target to proceed without a ready, non-empty auth
 * policy. Loopback binds are always allowed, auth-enabled or not, to
 * preserve local VS Code / localhost workflows.
 */
export function assertBindTargetAuthReady(host: string | null | undefined, authPolicyReady: boolean): void {
    if (!isRemoteBindHost(host)) {
        return;
    }
    if (authPolicyReady) {
        return;
    }
    throw new InsecureRemoteBindError((host ?? '').trim() || '(unspecified)');
}
