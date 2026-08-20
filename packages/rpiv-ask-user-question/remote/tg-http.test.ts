import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProxy } from "./tg-http.js";

const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY"] as const;

describe("resolveProxy", () => {
	beforeEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});
	afterEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});

	it("prefers the explicit config over env", () => {
		process.env.HTTPS_PROXY = "http://env-proxy:8080";
		expect(resolveProxy("http://cfg-proxy:3128")).toEqual({ host: "cfg-proxy", port: 3128 });
	});

	it("falls back to the HTTPS_PROXY env", () => {
		process.env.HTTPS_PROXY = "http://127.0.0.1:6152";
		expect(resolveProxy(undefined)).toEqual({ host: "127.0.0.1", port: 6152 });
	});

	it("normalizes a proxy without a scheme", () => {
		process.env.https_proxy = "proxy.local:8080";
		expect(resolveProxy()).toEqual({ host: "proxy.local", port: 8080 });
	});

	it("skips malformed candidates and keeps looking", () => {
		process.env.HTTP_PROXY = "not a url";
		process.env.ALL_PROXY = "http://ok:1";
		expect(resolveProxy()).toEqual({ host: "ok", port: 1 });
	});
});
