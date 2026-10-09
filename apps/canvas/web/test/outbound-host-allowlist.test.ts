import { afterEach, describe, expect, test } from "bun:test";

import {
    appendOutboundHostAllowlist,
    assertAllowlistedOutboundUrl,
    assertAxiosOutboundAllowed,
    outboundHostAllowed,
    resetOutboundHostAllowlistExtras,
} from "../src/lib/outbound-host-allowlist";

afterEach(() => {
    resetOutboundHostAllowlistExtras();
});

describe("outboundHostAllowed defaults", () => {
    test("allows production and loopback defaults on any port", () => {
        expect(outboundHostAllowed("toiv.wineryz.top", "443")).toBe(true);
        expect(outboundHostAllowed("toiv.wineryz.top", "8090")).toBe(true);
        expect(outboundHostAllowed("updates.beefapi.com", "443")).toBe(true);
        expect(outboundHostAllowed("updates.beefapi.com", "80")).toBe(true);
        expect(outboundHostAllowed("localhost", "8090")).toBe(true);
        expect(outboundHostAllowed("127.0.0.1", "8090")).toBe(true);
        expect(outboundHostAllowed("::1", "8090")).toBe(true);
        expect(outboundHostAllowed("[::1]", "443")).toBe(true);
    });

    test("rejects unlisted and empty hosts", () => {
        expect(outboundHostAllowed("evil.example", "443")).toBe(false);
        expect(outboundHostAllowed("", "443")).toBe(false);
        expect(outboundHostAllowed("toiv.wineryz.top.evil.example", "443")).toBe(false);
    });
});

describe("appendOutboundHostAllowlist", () => {
    test("registers host-only and port-qualified extras", () => {
        expect(outboundHostAllowed("api.staging.test", "443")).toBe(false);
        appendOutboundHostAllowlist("api.staging.test", "api.staging.test", "10.77.0.5:18090");
        expect(outboundHostAllowed("api.staging.test", "8090")).toBe(true);
        expect(outboundHostAllowed("10.77.0.5", "18090")).toBe(true);
        expect(outboundHostAllowed("10.77.0.5", "18091")).toBe(false);
    });
});

describe("assertAllowlistedOutboundUrl", () => {
    test("allows production https and relative paths", () => {
        expect(assertAllowlistedOutboundUrl("https://toiv.wineryz.top/api/auth/me")?.hostname).toBe("toiv.wineryz.top");
        expect(assertAllowlistedOutboundUrl("https://updates.beefapi.com/desktop/latest.json")?.hostname).toBe("updates.beefapi.com");
        expect(assertAllowlistedOutboundUrl("/api/jobs")).toBeNull();
        expect(assertAllowlistedOutboundUrl("blob:http://localhost/abc")).toBeNull();
    });

    test("rejects empty, credentials, non-http, and unlisted hosts", () => {
        for (const raw of ["", "   ", "ftp://toiv.wineryz.top/", "https://user:pass@toiv.wineryz.top/"]) {
            expect(() => assertAllowlistedOutboundUrl(raw)).toThrow();
        }
        expect(() => assertAllowlistedOutboundUrl("https://evil.example/exfil")).toThrow(/允许列表/);
    });
});

describe("assertAxiosOutboundAllowed", () => {
    test("no-ops for relative baseURL clients", () => {
        expect(() => assertAxiosOutboundAllowed({ baseURL: "/api", url: "/jobs" })).not.toThrow();
    });

    test("allows absolute loopback API base and rejects evil absolute URL", () => {
        expect(() => assertAxiosOutboundAllowed({ baseURL: "http://127.0.0.1:18090/api", url: "/workspace/bootstrap" })).not.toThrow();
        expect(() => assertAxiosOutboundAllowed({ baseURL: "https://evil.example", url: "/exfil" })).toThrow(/允许列表/);
        expect(() => assertAxiosOutboundAllowed({ url: "https://evil.example/exfil" })).toThrow(/允许列表/);
    });
});
