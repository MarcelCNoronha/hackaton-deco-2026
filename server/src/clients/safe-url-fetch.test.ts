import { describe, expect, it } from "vitest";
import { isBlockedHostname, isBlockedIpAddress } from "./safe-url-fetch.js";

describe("safe URL guard", () => {
  it("blocks local hostnames", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("admin.localhost")).toBe(true);
    expect(isBlockedHostname("example.com")).toBe(false);
  });

  it("blocks private and local IPv4 ranges", () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.1.2.3")).toBe(true);
    expect(isBlockedIpAddress("172.16.0.1")).toBe(true);
    expect(isBlockedIpAddress("192.168.1.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
  });

  it("blocks local and private IPv6 ranges", () => {
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("fe80::1")).toBe(true);
    expect(isBlockedIpAddress("fc00::1")).toBe(true);
    expect(isBlockedIpAddress("2606:4700:4700::1111")).toBe(false);
  });
});
