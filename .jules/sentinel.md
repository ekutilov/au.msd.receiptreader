# Sentinel Security Journal - au.msd.receiptreader

This journal documents critical security learnings, vulnerability patterns, and prevention strategies specific to this project.

## 2025-03-08 - Protocol Validation and DOM XSS Mitigation
**Vulnerability:** Insecure protocol transport (fetching dynamic configuration or making proxied fetches over HTTP) and potential DOM XSS via unvalidated iframe sources.
**Learning:** When loading dynamic configuration urls or using a proxied fetch helper, failing to enforce HTTPS allows potential Man-in-the-Middle (MITM) attacks and credential leakage. Additionally, dynamically setting `iframe.src` with unvalidated URL inputs can lead to XSS if a `javascript:` URL scheme is injected.
**Prevention:** Enforce strict protocol checks (`https://`) on any dynamic configuration URLs, proxy endpoints, proxied target URLs, and dynamically injected iframe sources.
