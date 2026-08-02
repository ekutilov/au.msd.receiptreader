# Bolt's Journal - Critical Performance Learnings

## 2026-08-02 - URLPattern Polyfill Matching Overhead
**Learning:** The `URLPattern` polyfill is an extremely heavy and expensive library. Instantiating a `new URLPattern` within filtering loops inside `return_connector` introduces massive performance bottlenecks (~26x slower compared to vanilla regex matching) and suffers from compatibility issues across browsers like Safari and Firefox.
**Action:** Replace `URLPattern` matching with a simple, cached regular expression-based pattern matcher. Pre-compile and cache wildcards (e.g. converting `*` to `.+` or `.*` and caching the compiled `RegExp` object) to eliminate redundant regex compilation and pattern parsing.
