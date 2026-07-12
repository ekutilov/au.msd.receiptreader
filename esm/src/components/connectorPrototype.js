
export default function connectorPrototype(obj) {
    
    const defaultRequestTimeout = 9*1000;

    return {
        api_ver: "v1.1.0",   
        parent: obj,
        defaultConnectorConfig: {},
        cache: new Map(),
        customer_id: "not provided",
        request_timeout: defaultRequestTimeout,
        get console() {
            return this.parent?.logger || console;
        },
        onStreamStart: null,
        onStreamChunk: null,
        onStreamCancel: null,
        onStreamEnd: null,
        async init(options = {}) {
            const connector = this;
            const initialState = {
                connector_id: this.id,
                connector_name: this.name,
                auth_state: "unknown",
                download_status: "idle",
                url: window.location.href,
                pc: 0,
                message: null,
                error: null,
                metadata: {},
                ts: Date.now()
            };

            const handler = {
                set(target, prop, value) {
                    target[prop] = value;
                    target.ts = Date.now();

                    // Dispatch CustomEvent for MAIN world communication
                    const event = new CustomEvent('msd-state-update', { detail: { ...target } });
                    window.dispatchEvent(event);

                    // Call optional callback
                    if (options.onStateChange) {
                        options.onStateChange({ ...target });
                    }

                    return true;
                }
            };

            this.state = new Proxy(initialState, handler);

            // Initial auth check
            this.page_is_authorised().then(isAuth => {
                this.state.auth_state = isAuth ? "authenticated" : "unauthenticated";
            });

            if (options.onStreamStart) this.onStreamStart = options.onStreamStart;
            if (options.onStreamChunk) this.onStreamChunk = options.onStreamChunk;
            if (options.onStreamCancel) this.onStreamCancel = options.onStreamCancel;
            if (options.onStreamEnd) this.onStreamEnd = options.onStreamEnd;

            if (options.request_timeout) {
                this.request_timeout = options.request_timeout
            } else {
                this.request_timeout = defaultRequestTimeout
            }

            if (options.load_config) {
                let config_url = options.load_config
                let config_online = await fetch(config_url)
                if (config_online.ok) {
                    let config_content = await config_online.json()
                    this.config = {...this.config, ...config_content, ...config_content.connectors[this.id]?.config||{}}
                }
            }

            if (options.config) {
                this.config = {...this.config, ...options.config, ...options.config.connectors[this.id]?.config||{}}
            }

            if (this._syncStateListener) {
                window.removeEventListener('msd-state-sync', this._syncStateListener);
            }
            this._syncStateListener = () => {
                this.syncState();
            };
            window.addEventListener('msd-state-sync', this._syncStateListener);

        },
        syncState() {
            if (this.state) {
                const event = new CustomEvent('msd-state-update', { detail: { ...this.state } });
                window.dispatchEvent(event);
            }
        },
        getState() {

            return this.state;
        },
        setStreamCallbacks(callbacks = {}) {
            if (callbacks.onStreamStart) this.onStreamStart = callbacks.onStreamStart;
            if (callbacks.onStreamChunk) this.onStreamChunk = callbacks.onStreamChunk;
            if (callbacks.onStreamCancel) this.onStreamCancel = callbacks.onStreamCancel;
            if (callbacks.onStreamEnd) this.onStreamEnd = callbacks.onStreamEnd;
            return this;
        },
        async pull(filter={}) { // download requested data

            obj.store.cancelRun=false // reset cancel flag for this tab

            this.state.download_status = "in_progress";
            this.state.pc = 0;
            this.state.message = "Checking authorization";

            const cc = this.config

            if (!(await this.page_is_authorised())) {
                this.console.error("Attempt to call pull when page is not authorised")
                this.state.download_status = "download_failed";
                this.state.error = "Page is not authorised";
                this.state.message = "Authorization failed";
                return {status: { ...this.state }, content: {} }
            }

            this.state.auth_state = "authenticated";
            this.state.message = "Fetching transactions";

            let max_errors = cc?.max_errors || 5;

            const transactions_1 = await this.get_transactions(filter)

            let transactions;

            if (transactions_1 && Array.isArray(transactions_1)) {
                transactions = transactions_1.filter(el=>(el!==null && el!==undefined))
            } else {
                transactions = []
                this.console.error("get_transactions returned an invalid value: ", transactions_1)
            }

            let length = transactions?.length || 0
            
            if (length===0) {
                this.console.error(`No transactions found or download error: connector: ${this.name}, id: ${this.id}, ver: ${ this.ver}`)
                this.state.download_status = "download_failed";
                this.state.error = "No transactions found or download error: try to refresh the page";
                this.state.message = "No transactions found";
                return { status: { ...this.state }, content: {} }
            }

            // shuffle transactions
            transactions = transactions.sort(() => Math.random() - 0.5)

            this.state.metadata = { total_items: length, current_item: 0 };
            this.state.message = `Found ${length} transactions. Starting download...`;

            // Trigger stream initiator
            const streamStartData = { expected_chunks: length+1, transactions_index: [...transactions, {id: "metadata", type: "metadata"}] };
            if (typeof this.onStreamStart === 'function') {
                try {
                    await this.onStreamStart(streamStartData);
                } catch (e) {
                    this.console.error("Error in onStreamStart callback: ", e);
                }
            }
            // Dispatch as DOM event for agnostic listeners
            window.dispatchEvent(new CustomEvent('msd-stream-start', { detail: streamStartData }));

            for (let i=0; i<length ; i++) {

                this.state.pc = (i / length) * 100;
                this.state.metadata = { ...this.state.metadata, current_item: i + 1 };
                this.state.message = `Downloading receipt ${i + 1} of ${length}`;

                try {
                    // Timeout logic for get_ereceipt
                    const timeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Timeout: get_ereceipt took too long")), this.request_timeout)
                    )

                    const ereceipt = await Promise.race([this.get_ereceipt(transactions[i]), timeout]);
        
                    transactions[i].ereceipt = ereceipt
                    
                    // Trigger stream chunk
                    const streamChunkData = { index: i, expected_chunks: length+1, chunk: { download: [transactions[i]] } };
                    if (typeof this.onStreamChunk === 'function') {
                        try {
                            await this.onStreamChunk(streamChunkData);
                        } catch (e) {
                            this.console.error("Error in onStreamChunk callback: ", e);
                        }
                    }
                    // Dispatch as DOM event for agnostic listeners
                    window.dispatchEvent(new CustomEvent('msd-stream-chunk', { detail: streamChunkData }));
        
                    if (obj.store.cancelRun) {
                        this.state.download_status = "download_cancelled";
                        this.state.message = "Download cancelled by user";
                        this.console.log("Download cancelled by user request")

                        // Trigger stream cancel
                        const streamCancelData = { index: i, expected_chunks: length };
                        if (typeof this.onStreamCancel === 'function') {
                            try {
                                await this.onStreamCancel(streamCancelData);
                            } catch (e) {
                                this.console.error("Error in onStreamCancel callback: ", e);
                            }
                        }
                        window.dispatchEvent(new CustomEvent('msd-stream-cancel', { detail: streamCancelData }));

                        return { status: { ...this.state }, content: this.download_postprocessor(transactions) }
                    }

                } catch (e) {

                    this.console.error(`Error in ereceipt scraper [${this.id}]: `, e, transactions[i]);

                    transactions[i].ereceipt_status = { error: JSON.stringify(e) };
                    if (max_errors-- < 0) {
                        this.console.error(`Too many fetch errors in ereceipt scraper [${this.id}]: `, e);

                        this.state.download_status = "download_failed";
                        this.state.error = "Too many errors when fetching data";
                        this.state.message = "Download failed due to too many errors";

                        // Trigger stream cancel due to too many errors
                        const streamCancelData = { index: i, expected_chunks: length, reason: "too_many_errors", error: e.message || JSON.stringify(e) };
                        if (typeof this.onStreamCancel === 'function') {
                            try {
                                await this.onStreamCancel(streamCancelData);
                            } catch (err) {
                                this.console.error("Error in onStreamCancel callback: ", err);
                            }
                        }
                        window.dispatchEvent(new CustomEvent('msd-stream-cancel', { detail: streamCancelData }));

                        return { status: { ...this.state }, content: this.download_postprocessor(transactions) }
                    }
                }
            } 

            this.state.pc = 100;
            this.state.message = "Finalizing download";

            // number of transactions with ereceipts:
            const length_success = transactions.filter(el=>el.ereceipt)?.length || 0

            const customer_id = await this.get_customer_id()
            // if (transactions.length > 0) {
            //     transactions[0].scraper = { clientId: customer_id, ver: (this.config).ver, captureTime:(new Date()).toISOString() }
            // }

            const processed_data = this.download_postprocessor(transactions);

            this.state.download_status = "completed";
            this.state.message = "Download completed successfully";
            this.state.metadata = { ...this.state.metadata, ereceipts_count: length_success };
            this.state.downloaded_data = processed_data;

            // Extract 'download' out, and collect everything else into 'newUser'
            const { download, ...metadata } = processed_data;
            
            const streamChunkData_fin = { index: 0, expected_chunks: length+1, chunk: metadata };
            if (typeof this.onStreamChunk === 'function') {
                try {
                    await this.onStreamChunk(streamChunkData_fin);
                } catch (e) {
                    this.console.error("Error in onStreamChunk callback: ", e);
                }
            }
            window.dispatchEvent(new CustomEvent('msd-stream-chunk', { detail: streamChunkData_fin }));

            // Trigger stream end
            const streamEndData = { expected_chunks: length+1, total_success: length_success+1 };
            if (typeof this.onStreamEnd === 'function') {
                try {
                    await this.onStreamEnd(streamEndData);
                } catch (e) {
                    this.console.error("Error in onStreamEnd callback: ", e);
                }
            }
            window.dispatchEvent(new CustomEvent('msd-stream-end', { detail: streamEndData }));

            return { status: { ...this.state }, content: processed_data }
            
        }
        ,
        async page_is_authorised() {
            return false
        }
        ,
        async get_customer_id() {
            return 'undefined'
        }
        ,
        async get_transactions() {
            return []
        }
        ,
        async get_transaction_count() {

            // const state = await this.state.get()

            // if (state?.transactions_summary?.count && Date.now() - state?.transactions_summary?.ts<5*60*1000) return state.transactions_summary.count

            this.state.message = 'Checking transactions'

            const transactions_1 = await this.get_transactions()

            let transactions;

            if (transactions_1 && Array.isArray(transactions_1)) {
                transactions = transactions_1.filter(el=>(el!==null && el!==undefined))
            } else {
                transactions = []
                this.console.error("get_transactions returned an invalid value: ", JSON.stringify({value:transactions_1}))
            }

            const count = transactions?.length || 0
            
            this.state.message = `Found ${count} transactions`

            // const count = 33
            // await this.state.set({ transactions_summary: { count: count, ts: Date.now() } })
            
            return count
        }
        ,
        async get_ereceipt(t) { // id may be an object if the api call requires more than one parameter
            const id = t?.id || "id"
            return {}
        }
        ,
        async get_site_variable(key) { // Helper function - get a variable from the site's context (MAIN world)
            
            return window[key]

        }
        ,
        async injected_fetch(url, options) {

            return fetch(url, options)

        }
        ,
        download_postprocessor(data) { // dummy method
        //            return data // postprocessor should pass through the data we need to keep in the final file

            return { 
                brand: this.id, 
                metabrand: this.id,
                captureTime: (new Date()).toISOString(), 
                connector_ver: this.ver,
                api_ver: this.api_ver,
                download: data,
                normalised_data: undefined,
            }
        }
        ,
        getJSONnode(data, node) {
            if (typeof data === "object") { data = Object.values(data) }
            if (typeof data === "string") { data = JSON.parse(data) }
            if (typeof node === "string") { node = [node] }
            if (typeof node === "object") {
                for (let i = 0; i < node.length; i++) {
                    const n = node[i]
                    if (data[n]) {
                        data = data[n]
                    } else {
                        console.error("Node not found", n)
                        return undefined
                    }
                }
            }
            return data
        },
        proxied_fetch: async function(url, options) { 
            // for situations when CORS or other issues prevent us from making the necessary API
            //  calls directly from the page context. Requires a proxy to be set up and configured in 
            // the connector config: obj.load_custom_config({ proxy: "https://my-proxy.com/", proxy_secret: "supersecret)
            // replace with your own implementation for other use cases.
            const c = this.config

            if (!c.proxy) { return false }

            const proxy_url = c.proxy + url
            const proxy_secret = c.proxy_secret
            if (!proxy_secret) { return false }

            const response = await fetch(proxy_url, {
                ...options,
                headers: {
                    ...options.headers,
                    "x-target-url": url,
                    "x-proxy-secret": proxy_secret,
                },
            })

            return response
        }
    }
}
