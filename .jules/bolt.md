# Bolt's Journal ⚡

## 2026-07-28 - [Glob Pattern Matcher & URLPattern Overuse]
**Learning:** Overusing heavy API polyfills like `URLPattern` in client-side scrapers or extensions can lead to massive bundle sizes and significant CPU time. In our case, the polyfill in `urlpattern.js` was 19KB of source code (making up over 35% of our compiled bundle) and took ~180ms to perform 1,000 matches. Replacing it with standard precompiled `RegExp` pattern matches reduced pattern matching overhead by 100x (down to ~1.6ms) and dropped the final bundle size drastically.
**Action:** Always prefer native standard RegExp or simpler string-based pattern matching over heavy polyfills when dealing with simple glob patterns. Precompile regular expressions on module load instead of recreating and parsing them inside loops.
