import { describe, expect, it } from "vitest";
import {
  InvalidSalesbuildrBaseUrlError,
  isSalesbuildrHost,
  normalizeSalesbuildrApiBase,
  optionalSalesbuildrApiBase,
} from "../utils/base-url.js";

describe("isSalesbuildrHost", () => {
  it("allows portal and tenant subdomains", () => {
    expect(isSalesbuildrHost("portal.salesbuildr.com")).toBe(true);
    expect(isSalesbuildrHost("acme.salesbuildr.com")).toBe(true);
    expect(isSalesbuildrHost("ACME.SalesBuildr.com.")).toBe(true);
    expect(isSalesbuildrHost("salesbuildr.com")).toBe(true);
  });

  it("rejects lookalikes and empty labels", () => {
    expect(isSalesbuildrHost("salesbuildr.com.evil.com")).toBe(false);
    expect(isSalesbuildrHost("evil.salesbuildr.com.attacker.com")).toBe(false);
    expect(isSalesbuildrHost("notsalesbuildr.com")).toBe(false);
    expect(isSalesbuildrHost("salesbuildr.com.evil")).toBe(false);
    expect(isSalesbuildrHost(".salesbuildr.com")).toBe(false);
  });
});

describe("normalizeSalesbuildrApiBase", () => {
  it("treats a single DNS label as the tenant subdomain", () => {
    expect(normalizeSalesbuildrApiBase("acme")).toBe(
      "https://acme.salesbuildr.com/public-api"
    );
    expect(normalizeSalesbuildrApiBase("WilroffReitsma")).toBe(
      "https://wilroffreitsma.salesbuildr.com/public-api"
    );
  });

  it("accepts a host or full https URL, with or without /public-api", () => {
    expect(normalizeSalesbuildrApiBase("acme.salesbuildr.com")).toBe(
      "https://acme.salesbuildr.com/public-api"
    );
    expect(
      normalizeSalesbuildrApiBase("https://acme.salesbuildr.com")
    ).toBe("https://acme.salesbuildr.com/public-api");
    expect(
      normalizeSalesbuildrApiBase("https://acme.salesbuildr.com/public-api")
    ).toBe("https://acme.salesbuildr.com/public-api");
    expect(
      normalizeSalesbuildrApiBase("https://acme.salesbuildr.com/public-api/companies")
    ).toBe("https://acme.salesbuildr.com/public-api");
  });

  it("rejects a blank value, http, credentials, a non-default port, and off-allowlist hosts", () => {
    expect(() => normalizeSalesbuildrApiBase("   ")).toThrow(
      InvalidSalesbuildrBaseUrlError
    );
    expect(() =>
      normalizeSalesbuildrApiBase("http://acme.salesbuildr.com")
    ).toThrow(/must use https/);
    expect(() =>
      normalizeSalesbuildrApiBase("https://user:pass@acme.salesbuildr.com")
    ).toThrow(/must not include credentials/);
    expect(() =>
      normalizeSalesbuildrApiBase("https://acme.salesbuildr.com:8443")
    ).toThrow(/default https port/);
    expect(() => normalizeSalesbuildrApiBase("https://evil.com")).toThrow(
      /must be a https:\/\/\*\.salesbuildr\.com host/
    );
    expect(() =>
      normalizeSalesbuildrApiBase("https://salesbuildr.com.evil.com")
    ).toThrow(/must be a https:\/\/\*\.salesbuildr\.com host/);
    expect(() =>
      normalizeSalesbuildrApiBase("https://169.254.169.254")
    ).toThrow(/must be a https:\/\/\*\.salesbuildr\.com host/);
  });

  it("treats an omitted header as unset and a present value as canonical", () => {
    expect(optionalSalesbuildrApiBase(undefined)).toBeUndefined();
    expect(optionalSalesbuildrApiBase("acme")).toBe(
      "https://acme.salesbuildr.com/public-api"
    );
  });
});
