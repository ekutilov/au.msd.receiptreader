# AI Agent Integration Guide: au.msd.receiptreader

This guide is for AI agents developing a browser extension that integrates this receipt-capturing ESM module.

## Core Architectural Model

1.  **Environment**: The module MUST run in the **MAIN world** of the retailer's website to access site-specific variables (like `__NEXT_DATA__` or `colData`) and perform authenticated fetches.
2.  **Lifecycle**:
    *   **MAIN World**: The module runs here to access retailer site data. It dispatches `CustomEvents` on the `window` object when state changes or data is captured.
    *   **ISOLATED World**: A secondary content script listens for these events and synchronizes data to `chrome.storage` or relays it to the background script.
    *   **Background Script/Popup**: Reads from `chrome.storage` to display UI and triggers actions (like `pull()`) via `chrome.scripting.executeScript`.

3.  **Communication Flow**:
    `Module (MAIN)` ---[CustomEvents]---> `Sync Script (ISOLATED)` ---[chrome.storage]---> `Background/Popup`

## Step-by-Step Implementation

### 1. Injection Strategy
The module must be injected into the `MAIN` world. The synchronization script must be in the `ISOLATED` world.

**manifest.json example:**
```json
"content_scripts": [
  {
    "matches": ["*://*.coles.com.au/*", "*://*.woolworths.com.au/*"],
    "js": ["main_world_loader.js"],
    "world": "MAIN"
  },
  {
    "matches": ["*://*.coles.com.au/*", "*://*.woolworths.com.au/*"],
    "js": ["support_modules/state_sync/state_sync.js"],
    "world": "ISOLATED"
  }
]
```

### 2. Module Setup (main_world_loader.js - MAIN World)
```javascript
const ESM_URL = 'https://storage.googleapis.com/msd-dev/p/msd_module.bundle.js';

async function setup() {
    const msd = (await import(ESM_URL)).default;
    const connector = msd.connector;

    if (!connector) return;

    // Initialize. The connector automatically dispatches CustomEvents
    // (msd-state-update, msd-stream-chunk, etc.) to the window.
    await connector.init();
}
setup();
```

### 3. State Synchronization (state_sync.js - ISOLATED World)
Use the provided `support_modules/state_sync/state_sync.js` which handles:
- Fetching the Tab ID from the background script.
- Buffering high-frequency events.
- Storing state in `chrome.storage.local` and captured receipts in `chrome.storage.session`.

### 4. Background Script Coordination
The background script must respond to `GET_TAB_ID` and can then monitor storage.

```javascript
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_TAB_ID') {
        sendResponse({ tabId: sender.tab.id });
        return true;
    }
});

// Crucial: Allow ISOLATED world content scripts to access session storage
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// Example: Monitoring state changes from background
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        for (let [key, { newValue }] of Object.entries(changes)) {
            if (key.startsWith('tab_')) {
                console.log(`Tab ${key} state updated:`, newValue);
            }
        }
    }
});
```

## Recommended Mode of Use
- **Use the Singleton**: Always access `msd.connector`. Do not attempt to instantiate connectors manually.
- **Async Initialization**: Always call `await connector.init()` before `pull()`.
- **Stateless Background**: Treat the background script as a relay. The source of truth for the scraping process remains in the `connector.state` within the content script.

## What to Avoid
- **Avoid Cross-World Injection**: Do not import this module into an `ISOLATED` world content script. It will fail to access the necessary page data.
- **Avoid Multiple Runs**: Do not call `pull()` if `state.download_status` is already `in_progress`.
- **Avoid Extension APIs in Module**: The module is agnostic. Do not add `chrome.*` calls inside the ESM source; keep that logic in your containing content script.

## Connector API Reference

The `msd.connector` singleton provides the following methods for integration.

### `init(options)`
Initializes the connector and its reactive state.

- **Parameters**:
    - `options` (Object):
        - `onStateChange` (Function): Callback receiving the updated `state` object.
        - `onStreamStart` (Function): Callback when data streaming begins.
        - `onStreamChunk` (Function): Callback for each data chunk received.
        - `onStreamCancel` (Function): Callback if the stream is cancelled.
        - `onStreamEnd` (Function): Callback when the stream finishes.
        - `request_timeout` (Number): Timeout for API requests in milliseconds (default: 10000).
        - `proxy` (String): Proxy URL for proxied fetches.
        - `proxy_secret` (String): Secret key for proxy authentication.
- **Returns**: `Promise<void>`

### `getState()`
Retrieves the current state of the connector.

- **Returns**: `Object` - The current [State Object](#state-object-reference).

### `pull(filter)`
Starts the process of fetching transactions and their associated receipts.

- **Parameters**:
    - `filter` (Object): Optional filter criteria passed to the connector's internal `get_transactions` method.
- **Returns**: `Promise<Object>`:
    - `status` (Object): Final [State Object](#state-object-reference).
    - `content` (Array): List of captured transaction objects.

### `page_is_authorised()`
Checks if the user is currently authenticated on the retailer's website.

- **Returns**: `Promise<Boolean>`

### `get_transaction_count()`
Retrieves the total number of transactions available for capture.

- **Returns**: `Promise<Number>`

### `get_supported_connectors()`
Retrieves a list of all retailers supported by the module. This is a static method on the default export, but also available on the instance.

- **Returns**: `Array<Object>`:
    - `id` (String): Unique identifier (e.g., 'coles').
    - `name` (String): Human-readable name.
    - `url` (String): Base URL of the retailer.
    - `patterns` (Array): List of glob patterns for URL matching.
    - `enabled` (Boolean): Whether the connector is active.

### `setStreamCallbacks(callbacks)`
Updates or sets the streaming callbacks after initialization.

- **Parameters**:
    - `callbacks` (Object): Same callback structure as in `init`.
- **Returns**: `Object` - The connector instance (for chaining).

## State Object Reference

The `connector.state` is a reactive Proxy object. Any change to its properties dispatches a `msd-state-update` event and triggers the `onStateChange` callback.

### Structure
| Property | Type | Description |
| :--- | :--- | :--- |
| `connector_id` | `string` | Unique identifier for the retailer connector (e.g., "coles"). |
| `connector_name` | `string` | Human-readable name of the retailer. |
| `auth_state` | `string` | Current authentication status. See [Transitions](#auth_state-transitions). |
| `download_status` | `string` | Progress status of the `pull()` operation. See [Transitions](#download_status-transitions). |
| `url` | `string` | The current window URL. |
| `pc` | `number` | Progress percentage (0 to 100). |
| `message` | `string` | Human-readable status message for UI display. |
| `error` | `string\|null` | Error message if `download_status` is `download_failed`. |
| `metadata` | `object` | Contextual data (e.g., `{ total_items, current_item, ereceipts_count }`). |
| `ts` | `number` | Unix timestamp of the last state update. |

### Transitions

#### `auth_state` Transitions
1.  **`unknown`**: Initial state before check.
2.  **`authenticated`**: User is logged in and ready.
3.  **`unauthenticated`**: User needs to log in to the retailer site.

#### `download_status` Transitions
1.  **`idle`**: Initial state, waiting for `pull()`.
2.  **`in_progress`**: Currently fetching data.
3.  **`completed`**: Success. Data is ready.
4.  **`download_failed`**: A fatal error occurred (check `state.error`).
5.  **`download_cancelled`**: Process was interrupted by user request.

### Automation Logic
- Monitor `auth_state === 'unauthenticated'` to prompt user login.
- Monitor `download_status === 'completed'` to process the results of `pull()`.
- Bind `pc` and `message` directly to your UI progress components.
