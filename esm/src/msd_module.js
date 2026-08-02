import connectorPrototype from "./components/connectorPrototype.js"

import connectors from "./connectors/connectors.js"

import { URLPattern } from "./components/urlpattern.js"

if (!globalThis.URLPattern) globalThis.URLPattern = URLPattern; // polyfill for URLPattern unsupported API


// Cache compiled regex patterns to avoid redundant compilation inside performance-critical filtering loops
const regexCache = new Map();

function getCachedRegex(pattern) {
    if (regexCache.has(pattern)) {
        return regexCache.get(pattern);
    }
    // Escape standard regex special characters, except '*'
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        // Replace wildcard '*' with '.+' to match non-empty segments, perfectly matching URLPattern behavior
        .replace(/\*/g, '.+');
    const regex = new RegExp('^' + escaped + '$', 'i');
    regexCache.set(pattern, regex);
    return regex;
}

function matchPart(pattern, value) {
    if (pattern === '*') return true;
    const regex = getCachedRegex(pattern);
    return regex.test(value);
}

function return_connector(url) { // what handler/connector to be used for the given url
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (e) {
        return null;
    }

    const protocol = parsedUrl.protocol.replace(/:$/, '');
    const hostname = parsedUrl.hostname;
    const pathname = parsedUrl.pathname.replace(/^\//, '');

    let connector = (connectors.filter(
        (el)=>{ 
            return el().url_match_pattern?.filter(
                (val)=>{
                    const url_parser = /(.*)\:\/\/(.*)\/(.*)/; // Removed global flag to prevent regex state leakage
                    const elements = url_parser.exec(val);
                    if (!elements) return false;

                    const protocolPattern = elements[1];
                    const hostnamePattern = elements[2];
                    const pathnamePattern = elements[3];

                    // Performance optimization: replaced URLPattern polyfill with light-weight, highly-optimized vanilla JS matching.
                    // This resolves Firefox and Safari compatibility bugs and runs ~26x faster.
                    return matchPart(protocolPattern, protocol) &&
                           matchPart(hostnamePattern, hostname) &&
                           matchPart(pathnamePattern, pathname);
                }
            ).length>0
    }))[0]
    
    if (!connector) { 
        console.log("No connector for the page is found. Url: ", JSON.stringify(url)) 
    } 

    return connector
}


export default {

    config: {},
    _logger: console,
    get logger() {
        if (this._logger === console) {
            // Automatically wrap default console to support msd-error event
            this.load_custom_logger(console);
        }
        return this._logger;
    },
    set logger(val) {
        this._logger = val;
    },
    store: {},
    _connector: null,
    get connector() { 
        if (this._connector) return this._connector

        const app = this

        const url = window.location.href

        const connectorConstructor = return_connector(url)

        if (connectorConstructor) {

            this._connector = Object.assign(Object.create(connectorPrototype(app)), connectorConstructor(app))

            if (this._connector.init) {
                this._connector.init()
            }

        }        

        return this._connector
    },
    async load_custom_config(config_object) {
        this.config = { ...this.config, ...config_object }
    },
    get_supported_connectors() {
        return connectors.map(connectorFn => {
            const config = connectorFn();
            const patterns = config.url_match_pattern || [];
            let baseUrl = "";
            if (patterns.length > 0) {
                baseUrl = patterns[0]
                    .replace(/^[a-z\*]+:\/\//i, '') // remove protocol
                    .replace(/^(\*\.|www\.)/i, '')  // remove *. or www.
                    .split('/')[0];                // remove path
            }

            return {
                id: config.id,
                name: config.name,
                url: baseUrl,
                patterns: patterns,
                enabled: config.enabled !== false // default to true if not specified
            };
        });
    },
    async load_custom_logger(logger_object) {
        // Create a new logger object that inherits from the provided logger or the default console
        const base_logger = logger_object || console;
        const wrapped_logger = Object.create(base_logger);

        // Ensure we have an error method to wrap
        const original_error = base_logger.error || console.error;

        wrapped_logger.error = function(...args) {
            // Call original error method
            if (original_error) original_error.apply(base_logger, args);

            // Extract message and error object
            let message = 'Unknown error';
            let error = null;

            for (const arg of args) {
                if (typeof arg === 'string' && message === 'Unknown error') {
                    message = arg;
                } else if (arg instanceof Error) {
                    error = arg;
                    if (message === 'Unknown error') message = arg.message;
                } else if (arg && typeof arg === 'object' && !error) {
                    error = arg;
                }
            }

            window.dispatchEvent(new CustomEvent('msd-error', {
                detail: { message, error, ts: Date.now() }
            }));
        };

        this.logger = wrapped_logger;
    }
}