/**
 * SalesBuildr API hosts are tenant-specific
 * (`https://<tenant>.salesbuildr.com/public-api`). The library default is
 * portal.salesbuildr.com. In gateway mode the tenant base URL arrives on
 * X-SalesBuildr-Base-URL and must be allowlisted before it is passed to the
 * client — a request that already passed S2S verification is still not
 * allowed to aim the sidecar at an arbitrary host.
 */

export const DEFAULT_SALESBUILDR_API_BASE =
  "https://portal.salesbuildr.com/public-api";

const HOST_SUFFIX = ".salesbuildr.com";
const SAFE_SUBDOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

export class InvalidSalesbuildrBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSalesbuildrBaseUrlError";
  }
}

export function isSalesbuildrHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  // *.salesbuildr.com only (portal and tenant hosts). The apex is not a tenant.
  return host.endsWith(HOST_SUFFIX) && host.length > HOST_SUFFIX.length;
}

/**
 * Canonicalize a tenant subdomain or URL to `https://<host>/public-api`.
 * Accepts a single DNS label (`acme`), a host (`acme.salesbuildr.com`), or a
 * full https URL (with or without `/public-api`). Rejects anything whose host
 * is not `*.salesbuildr.com`.
 */
export function normalizeSalesbuildrApiBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new InvalidSalesbuildrBaseUrlError("Salesbuildr tenant URL is empty.");
  }

  let candidate = trimmed;
  if (SAFE_SUBDOMAIN_LABEL.test(trimmed)) {
    candidate = `https://${trimmed.toLowerCase()}.salesbuildr.com`;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    candidate = `https://${trimmed}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new InvalidSalesbuildrBaseUrlError(
      "Salesbuildr tenant URL is not a valid URL."
    );
  }

  if (url.protocol !== "https:") {
    throw new InvalidSalesbuildrBaseUrlError(
      "Salesbuildr tenant URL must use https."
    );
  }
  if (url.username || url.password) {
    throw new InvalidSalesbuildrBaseUrlError(
      "Salesbuildr tenant URL must not include credentials."
    );
  }
  if (url.port && url.port !== "443") {
    throw new InvalidSalesbuildrBaseUrlError(
      "Salesbuildr tenant URL must use the default https port."
    );
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isSalesbuildrHost(host)) {
    throw new InvalidSalesbuildrBaseUrlError(
      "Salesbuildr tenant URL must be a https://*.salesbuildr.com host."
    );
  }

  return `https://${host}/public-api`;
}

/**
 * Read an optional gateway header. `undefined` means the header was omitted
 * (use the library default). A present but unusable value throws.
 */
export function optionalSalesbuildrApiBase(
  raw: string | undefined
): string | undefined {
  if (raw === undefined) return undefined;
  return normalizeSalesbuildrApiBase(raw);
}
