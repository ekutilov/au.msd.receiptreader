# au.msd.receiptreader

Stand-alone single module solution for capturing digital shopping receipts from Australian retailer websites (Coles, Woolworths Everyday, Kmart, and others).

**Important** As it stands now, this code is intended for running in the original retailer's web page contexts (i.e. in the browser console while the page is open or a browser extension-injected script). This means the page manages authenication and context integrity itself, while this script only helps to automate the data retrieval in bulk. 

## Usage in a Browser Extension Content Script

This module is designed to be injected into the **MAIN** world of a retailer's website and used by a content script to capture receipt data.

### 1. Import the Module

Since the module is an ESM, you can import it dynamically from a CDN or a local path:

```javascript
const msd = (await import('https://storage.googleapis.com/msd-dev/p/msd_module.bundle.js')).default;
```

### 2. Access the Connector

The module automatically detects the correct connector based on the current URL. The `connector` property is a singleton; it will return the same instance once created.

```javascript
const connector = msd.connector;

if (!connector) {
    console.error("No connector found for this website.");
}
```

### 3. Get List of Supported Retailers

You can programmatically retrieve a list of all retailers supported by the module:

```javascript
const retailers = msd.get_supported_connectors();
/*
Returns: [
  {
    id: "coles",
    name: "Coles",
    url: "coles.com.au",
    patterns: ["*://*.coles.com.au/*"],
    enabled: true
  },
  ...
]
*/
```

### 4. Initialize and Observe State

The connector uses a reactive state management system. You can observe state changes in two ways:

#### Option A: Callback (Recommended for direct integration)

Pass an `onStateChange` callback to the `init()` method:

```javascript
await connector.init({
    onStateChange: (state) => {
        console.log("State updated:", state);
        // Send updates to your background script
        // chrome.runtime.sendMessage({ type: 'MSD_STATE_UPDATE', state });
    }
});
```

#### Option B: DOM Events (Agnostic communication)

The module dispatches a `msd-state-update` CustomEvent on the `window` object whenever the state changes:

```javascript
window.addEventListener('msd-state-update', (event) => {
    const state = event.detail;
    console.log("State changed via event:", state);
});

await connector.init();
```

### 5. Trigger Data Download

Call the `pull()` method to start fetching receipts. You don't need to wait for it to resolve to see progress, as the state updates will be sent via the observers above.

```javascript
const result = await connector.pull();

if (result.status.download_status === 'completed') {
    console.log("Captured receipts:", result.content);
}
```

### State Object Structure

The state object provides granular information about the current operation:

| Property | Type | Description |
| :--- | :--- | :--- |
| `connector_id` | String | The ID of the active connector (e.g., 'coles'). |
| `auth_state` | String | `authenticated`, `unauthenticated`, or `unknown`. |
| `download_status` | String | `idle`, `in_progress`, `completed`, `download_failed`, `download_cancelled`. |
| `pc` | Number | Progress percentage (0 to 100). |
| `message` | String | Human-readable status message. |
| `error` | String | Error message if an operation fails. |
| `metadata` | Object | Additional details (e.g., `{ total_items: 10, current_item: 5 }`). |
| `ts` | Number | Timestamp of the last update. |

### 6. Streaming Data (Optional)

If you are piping large amounts of receipts into a database and want to write them continuously as they are crawled (to prevent data loss in case of a crash or cancellation), you can hook into the module's stream events.

#### Using Callbacks:
```javascript
await connector.init({
    onStreamStart: async (data) => console.log(`Starting stream, expecting ${data.expected_chunks} chunks`),
    onStreamChunk: async (data) => console.log(`Chunk ${data.index + 1}/${data.expected_chunks} received:`, data.chunk),
    onStreamCancel: async (data) => console.warn(`Stream aborted at chunk ${data.index + 1}. Reason: ${data.reason || 'user_cancelled'}`),
    onStreamEnd: async (data) => console.log(`Stream finished successfully! Captured ${data.total_success} receipts.`)
});
```
*(Callbacks can also be attached on the fly using `connector.setStreamCallbacks({ ... })`)*

#### Using DOM Events (Agnostic):
```javascript
window.addEventListener('msd-stream-chunk', (event) => {
    const { index, expected_chunks, chunk } = event.detail;
    console.log(`Received chunk ${index + 1} of ${expected_chunks}`);
});
```

Available CustomEvents: `msd-stream-start`, `msd-stream-chunk`, `msd-stream-cancel`, and `msd-stream-end`.

### 7. Custom Error Observer and Sentry Integration

You can capture errors and logs by providing a custom logger or listening to the `msd-error` event.

#### Sentry Integration Example:

The easiest way to integrate Sentry is by using `load_custom_logger`:

```javascript
import * as Sentry from "@sentry/browser";

const msd = (await import('https://storage.googleapis.com/myshopdash/p/msd_module.bundle.js')).default;

msd.load_custom_logger({
    error: (message, error, ...args) => {
        // If error is already an Error object, capture it directly
        const exception = error instanceof Error ? error : new Error(message);
        Sentry.captureException(exception, {
            extra: { message, args }
        });
    },
    warn: (message, ...args) => {
        Sentry.captureMessage(message, "warning");
    }
});
```

#### Using DOM Events for Errors:

The module dispatches a `msd-error` event whenever an internal error is logged.

```javascript
window.addEventListener('msd-error', (event) => {
    const { message, error, ts } = event.detail;
    console.error(`MSD Error: ${message}`, error);
});
```

#### Catch-all Wrapper for Unhandled Exceptions:

For absolute certainty in capturing all errors during a crawl, wrap the `pull()` call:

```javascript
try {
    const result = await msd.connector.pull();
} catch (e) {
    console.error("Critical scraper failure:", e);
    Sentry.captureException(e);
}
```
