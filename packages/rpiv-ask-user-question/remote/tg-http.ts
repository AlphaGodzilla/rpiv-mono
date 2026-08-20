import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type TLSSocket, connect as tlsConnect } from "node:tls";

/**
 * Zero-dependency, proxy-aware HTTPS client for the Telegram Bot API.
 *
 * The global `fetch` (undici) in Node 22 does NOT read proxy settings and does
 * not tunnel through an HTTP(S) proxy — on networks where Telegram requires a
 * proxy (e.g. the macOS system proxy used by curl), `fetch` fails with a TLS
 * reset while the same request via curl succeeds. This module replaces `fetch`
 * as the default transport with a `node:https` client that:
 *
 *   1. Resolves a proxy: explicit `tg.proxy` config → `HTTPS_PROXY`/`HTTP_PROXY`
 *      env → the macOS system proxy (`scutil --proxy`, cached) → none (direct).
 *   2. When a proxy is found, establishes a CONNECT tunnel to it, upgrades the
 *      socket to TLS with SNI, and issues the HTTPS request over the tunnel.
 *
 * The result shape (`{ status, json() }`) mirrors the slice of the Fetch API the
 * tg-channel transport uses, so `deps.fetch` (test seam) and this default stay
 * interchangeable.
 */

export interface TgHttpResponse {
	status: number;
	json(): Promise<unknown>;
}

export interface TgHttpInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export interface TgProxyInfo {
	host: string;
	port: number;
}

let macProxyCache: TgProxyInfo | undefined;
let macProxyChecked = false;

/** Best-effort macOS system HTTP(S) proxy, cached per process; undefined on other platforms. */
function macSystemProxy(): TgProxyInfo | undefined {
	if (macProxyChecked) return macProxyCache;
	macProxyChecked = true;
	if (process.platform !== "darwin") return undefined;
	try {
		const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 2_000 });
		const host = /HTTPSProxy\s*:\s*([^\s]+)/.exec(out)?.[1];
		const port = /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1];
		if (host && port) macProxyCache = { host, port: Number(port) };
	} catch {
		// No readable system proxy — direct connection.
	}
	return macProxyCache;
}

/** Resolve the proxy to use: explicit config → env → macOS system proxy → undefined (direct). */
export function resolveProxy(explicit?: string): TgProxyInfo | undefined {
	const candidates: string[] = [];
	if (explicit) candidates.push(explicit);
	for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"]) {
		const value = process.env[key];
		if (value) candidates.push(value);
	}
	for (const raw of candidates) {
		if (!raw) continue;
		try {
			const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
			const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
			if (u.hostname && port > 0) return { host: u.hostname, port };
		} catch {
			// Malformed candidate — try the next one.
		}
	}
	return macSystemProxy();
}

export type TgFetch = (input: string, init?: TgHttpInit) => Promise<TgHttpResponse>;

/** Build a fetch-like client that tunnels through the resolved proxy when one exists. */
export function createProxyAwareFetch(explicitProxy?: string): TgFetch {
	return (input, init = {}) =>
		new Promise<TgHttpResponse>((resolve, reject) => {
			const url = new URL(input);
			const method = init.method ?? "GET";
			const signal = init.signal;

			const run = (tlsSocket?: TLSSocket) => {
				const req = httpsRequest(
					url,
					{
						method,
						headers: init.headers,
						createConnection: tlsSocket ? () => tlsSocket : undefined,
					},
					(res) => {
						let raw = "";
						res.on("data", (chunk) => {
							raw += String(chunk);
						});
						res.on("end", () => {
							resolve({
								status: res.statusCode ?? 0,
								json: async () => {
									try {
										return JSON.parse(raw) as unknown;
									} catch {
										return {};
									}
								},
							});
						});
					},
				);
				signal?.addEventListener("abort", () => req.destroy(), { once: true });
				req.on("error", reject);
				if (init.body) req.write(init.body);
				req.end();
			};

			const proxy = resolveProxy(explicitProxy);
			if (!proxy) {
				run();
				return;
			}
			const connectReq = httpRequest({
				host: proxy.host,
				port: proxy.port,
				method: "CONNECT",
				path: `${url.hostname}:${url.port || 443}`,
			});
			connectReq.on("connect", (res, socket) => {
				if (res.statusCode !== 200) {
					socket.destroy();
					reject(new Error(`Proxy CONNECT to ${proxy.host}:${proxy.port} failed: HTTP ${res.statusCode}`));
					return;
				}
				const tlsSocket = tlsConnect({ socket, servername: url.hostname });
				tlsSocket.on("secureConnect", () => run(tlsSocket));
				tlsSocket.on("error", reject);
			});
			connectReq.on("error", reject);
			connectReq.end();
		});
}
