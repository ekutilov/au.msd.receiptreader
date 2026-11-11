// Verification script to verify the security of the new URL Pattern Matching translator
import msd from './esm/src/msd_module.js';
import assert from 'assert';

console.log('Starting Security Verification Tests for URL Pattern Matching...');

// Test URL pattern matching using return_connector function under various conditions
// Valid cases:
// 1. Coles: 'https://www.coles.com.au/some/path'
// 2. Everyday: 'https://www.everyday.com.au/rewards'
// 3. Kmart: 'https://www.kmart.com.au/checkout'

// Malicious / Invalid Spoofing cases:
// 1. 'https://evil-coles.com.au/' -> Should not match Coles
// 2. 'https://coles.com.au.attacker.com/' -> Should not match Coles
// 3. 'https://everyday.com.au.evil.com/' -> Should not match Everyday
// 4. 'https://evil-everyday.com.au/' -> Should not match Everyday
// 5. 'https://kmart.com.au.attacker.com/' -> Should not match Kmart
// 6. 'https://evilkmart.com.au/' -> Should not match Kmart

// Let's obtain the underlying return_connector / precompiledConnectors or test via a dynamic environment / mock
// Since return_connector is not exported, let's replicate the logic or test the behavior if we can import/test it.
// Wait, return_connector is a private function inside esm/src/msd_module.js but return_connector is called when accessing `connector` property on the `msd` export, which relies on `window.location.href`.
// Let's define `window` globally first to run this script safely in Node.

globalThis.window = {
    location: {
        href: ''
    },
    dispatchEvent() {},
    addEventListener() {},
    removeEventListener() {}
};
globalThis.localStorage = {};

function testUrl(url) {
    globalThis.window.location.href = url;
    // reset cached connector
    msd._connector = null;
    return msd.connector;
}

// 1. Coles tests
const colesConnector = testUrl('https://www.coles.com.au/home');
assert.ok(colesConnector !== null, 'Should match Coles under www.coles.com.au');
assert.strictEqual(colesConnector.id, 'coles', 'Matched connector should be Coles');

const colesNoSubdomain = testUrl('https://coles.com.au/home');
assert.ok(colesNoSubdomain !== null, 'Should match Coles under coles.com.au');

const colesSpoof1 = testUrl('https://evil-coles.com.au/');
assert.strictEqual(colesSpoof1, null, 'Should NOT match evil-coles.com.au');

const colesSpoof2 = testUrl('https://coles.com.au.attacker.com/');
assert.strictEqual(colesSpoof2, null, 'Should NOT match coles.com.au.attacker.com');

// 2. Everyday/Woolworths tests
const everydayConnector = testUrl('https://www.everyday.com.au/rewards');
assert.ok(everydayConnector !== null, 'Should match Everyday under www.everyday.com.au');
assert.strictEqual(everydayConnector.id, 'woolworths', 'Matched connector should be Everyday/Woolworths');

const everydaySpoof1 = testUrl('https://everyday.com.au.evil.com/');
assert.strictEqual(everydaySpoof1, null, 'Should NOT match everyday.com.au.evil.com');

const everydaySpoof2 = testUrl('https://evil-everyday.com.au/');
assert.strictEqual(everydaySpoof2, null, 'Should NOT match evil-everyday.com.au');

// 3. Kmart tests
const kmartConnector = testUrl('https://www.kmart.com.au/checkout');
assert.ok(kmartConnector !== null, 'Should match Kmart under www.kmart.com.au');
assert.strictEqual(kmartConnector.id, 'kmart', 'Matched connector should be Kmart');

const kmartSpoof1 = testUrl('https://kmart.com.au.attacker.com/');
assert.strictEqual(kmartSpoof1, null, 'Should NOT match kmart.com.au.attacker.com');

const kmartSpoof2 = testUrl('https://evilkmart.com.au/');
assert.strictEqual(kmartSpoof2, null, 'Should NOT match evilkmart.com.au');

console.log('✅ All security URL pattern matching verification tests passed!');
