# Sentinel's Journal 🛡️

## 2026-08-09 - [Insecure Glob-to-RegExp URL Pattern Matching]
**Vulnerability:** The glob-style match pattern translation in `msd_module.js` used a naive global replacement of `*` with `.*` after escaping. This translated pattern `*://*.coles.com.au/*` into `^.*:\/\/.*\.coles\.com\.au\/.*$`. This pattern matching was insecure and prone to domain spoofing, matching malicious domains such as `https://evil-coles.com.au/` or `https://notcoles.com.au/`.
**Learning:** Naive wildcard translation that conflates domain boundaries (like subdomains) with general wildcards is highly insecure. Attackers can leverage closely-named domains to trigger/spoof the context-sensitive extension script, bypassing safety mechanisms or attempting credential harvesting.
**Prevention:** Always parse match patterns into structured components (scheme, host, path) according to standard extension specification. Restrict the `*` wildcard parsing at the host layer to matching strictly defined subdomains (`(?:[^/.]+\\.)*`) and prevent arbitrary character consumption across subdomain/domain boundaries.
