# Sentinel Journal 🛡️

## 2026-08-02 - Server-Side Request Forgery and Credential Leakage in Proxy Fetching
**Vulnerability:** The `proxied_fetch` method concatenated any target `url` parameter directly to the configured `proxy` URL prefix without parsing or destination domain validation, and forwarded the custom proxy credential (`x-proxy-secret`) to that resulting URL. If the target URL was malformed or pointed to an untrusted external server, this could lead to Server-Side Request Forgery (SSRF) and leakage of sensitive proxy secrets to third-party endpoints.
**Learning:** This occurred because the scraper connector architecture relied on a simple proxy helper to bypass CORS, but did not enforce security boundary checks on the inputs passed to the browser's `fetch` API.
**Prevention:** Always parse and validate both proxy and target URLs using the native `URL` API, verify protocol safety (strictly HTTP/HTTPS), restrict the target hostnames to a trusted whitelist of retailer and receipts service domains, and format the concatenation cleanly to prevent authority bypass/open redirect tricks.
