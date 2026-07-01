import defaultConnectorConfig from "./config.js"

export default function(obj) {

    return {
        
        ...defaultConnectorConfig,
        
        async get_transactions(filter={}) {

            const c = this.config // const connector_config = {} // DEBUG

            this.console.debug("Coles scraper get_transactions is called ")
        
            const next_buildId = (await this.coles_credentials())?.next_buildId || c.next_buildId

            this.console.log("next_buildId: ", next_buildId)
        
            // Instore transactions

            let stop_flag = false
            let transactions = []
            let page = 1
            let error_counter = c.limit_fetch_errors
            let req

            let timeout = 600



            while (!stop_flag) {
                try { 
                    req = await this.fetchWithTimeout(
                        c.transactions_instore_url.replaceAll('___NEXTBUILDID___', next_buildId).replaceAll('___PAGENUMBER___', page),
                        {
                            method: 'GET',
                            headers: c.transactions_instore_request_headers,
                            credentials: 'include',
                            withCredentials: true,
                            mode: 'cors',
                        },
                        10000
                    )

                    this.console.debug('fetch response: ', JSON.stringify(req))

                    if (req?.status !== 200) {
                        this.console.error('Error in the fetch request to coles get_transactions (instore). Status: ', req?.status, 'fetch response: ', JSON.stringify(req).slice(0, 2000), 'req.statusText: ', req?.statusText)
                    } 

                    let page_content = await req.json()

                    for (const key of c.transactions_instore_node) {
                        page_content = page_content[key] || []
                    }

                    if (page_content.length === 0) {
                        stop_flag = true
                    } else {
                        page_content = page_content.map(d=>{return {_order_type: "instore", ...d}})
                        transactions = transactions.concat(page_content)
                        page++
                    }

                } catch (e) {
                    this.console.error('error in coles transactions scraper: ', e)
                    timeout = timeout + 400
                    if (error_counter-- === 0) {
                        stop_flag = true
                    }
                }
                await new Promise(r => setTimeout(r, timeout))
            }

            // Online transactions

            stop_flag = false
            page = 1
            error_counter = c.limit_fetch_errors
            timeout = 600

            while (!stop_flag) {
                try {
                    req = await this.fetchWithTimeout(
                        c.transactions_online_url.replaceAll('___NEXTBUILDID___', next_buildId).replaceAll('___PAGENUMBER___', page),
                        {
                            method: 'GET',
                            headers: c.transactions_online_request_headers,
                            credentials: 'include'
                        },
                        7000
                    )

                    if (req?.status !== 200) {
                        this.console.error('Error in the fetch request to coles bff (get_transactions, online). Status: ', req?.status, 'fetch response: ', JSON.stringify(req))

                    }

                    let page_content = await req.json()

                    for (const key of c.transactions_online_node) {
                        page_content = page_content[key] || []
                    }

                    if (page_content.length === 0) {

                        stop_flag = true

                    } else {

                        transactions = transactions.concat(page_content.map(d=>{ return {_order_type: "online", ...d} }))
                        page++

                    }

                } catch (e) {  
                    this.console.error('Error in transactions scraper (online): ', e?.message)
                    timeout = timeout + 400
                    if (error_counter-- === 0) {
                        stop_flag = true
                    }
                }
                await new Promise(r => setTimeout(r, timeout))
            }

            return transactions

        }
        ,
        async get_ereceipt(transaction_obj) { // transaction_id is an object with orderId and transactionId

            if (!transaction_obj) {
                this.console.error('get_ereceipt: transaction_obj is not valid: ', JSON.stringify({obj: transaction_obj}))
                return 
            }

            this.console.log('get_ereceipt: transaction_obj: ', JSON.stringify(transaction_obj))

            const c = this.config
        
            const next_buildId = (await this.coles_credentials())?.next_buildId || c.next_buildId 

            let order_url, order_headers, order_node

            if (transaction_obj._order_type === "online") {
                order_url = c.order_online_url 
                order_headers = c.order_online_headers
                order_node = c.order_online_node
            } else {
                order_url = c.order_instore_url 
                order_headers = c.order_instore_headers 
                order_node = c.order_instore_node 
            } // instore is default/fallback

            if (typeof order_url === "string") {
                order_url = [ order_url ]
            }

            order_url = order_url.map(d=>d.replaceAll('___NEXTBUILDID___', next_buildId).replaceAll('___ORDERID___', transaction_obj.orderId).replaceAll('___TRANSACTIONID___', transaction_obj.transactionId))

            let transaction = {}

            let req

            for (const url of order_url) {

                req = await this.fetchWithTimeout(
                    url,
                    {
                        method: 'GET',
                        headers: order_headers,
                        credentials: 'include'
                    },
                    7000
                )

                if (!req) {
                    this.console.error('Error in the fetch request - likely a timeout (get_ereceipt).')
                    return
                }

                if (req.status !== 200) {
                    this.console.error('Error in the fetch request to coles bff (get_ereceipt). Status: ', req.status, 'fetch response: ', JSON.stringify(req))
                    return
                }

                let page_content = await req.json()

                for (const key of order_node) {

                    page_content = page_content[key.replaceAll("___ORDERID___", transaction_obj.orderId).replaceAll("___TRANSACTIONID___", transaction_obj.transactionId)] 
                    page_content = page_content || []
                }

                transaction = {...transaction, ...page_content}
                await new Promise(r => setTimeout(r, 750))


            }

            // trying to get invoice too for online orders (more detailed data available) // experimental

            if (transaction_obj._order_type === "online") {

                try {
                    const timeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Timeout: fetch request took too long")), 7000) // 5 seconds timeout
                    );
                    const invoice_name = Object.values(transaction?.orderAttributes?.invoices).filter((e)=>e.format=="HTML")?.[0]?.fileName.match(/(.*)\.xml/)[1]
                    this.console.debug('invoice_name: ', invoice_name)

                    const invoice_url = c.order_invoice_url.replaceAll("___ORDERID___", transaction_obj.orderId).replaceAll("___INVOICE_NAME___", invoice_name)

                    // await Tab.app.browser.scripting.executeScript(
                    //     { target: { tabId: this.tab.browser_tab.id }, func: inject_iframe, args: [invoice_url], world: "ISOLATED" }
                    // )

                    await new Promise(r => setTimeout(r, 300))

                    const options = {
                        method: 'GET', 
                        headers: c.order_invoice_headers,
                        credentials: 'same-origin',
                        "referrer": `https://www.coles.com.au/account/orders/${transaction_obj.orderId}?fromstatus=past`,
                        "referrerPolicy": "strict-origin-when-cross-origin"
                    }

                    // req = await this.injected_fetch(
                    //         invoice_url,
                    //         options
                    //     )

                    req = await Promise.race([
                        this.injected_fetch(
                            invoice_url,
                            options
                        ),
                        timeout
                    ])

                    if (!req) {
                        this.console.error('Error in the fetch request - likely a timeout (get_ereceipt, invoice).')
                    }



                    this.console.debug('invoice fetch result: ', JSON.stringify(req).slice(0, 2000))

                    if (req.status !== 200) {
                        this.console.error('Error in the invoice fetch request to coles bff. Status: ', req.status)
                        this.console.log('fetch response: ', JSON.stringify(req))
                        this.console.log('fetch_object: ', req, req.status)
                    }

                    const req_text = await req?.text()

                    const rx = /\<script\s+id\=\"__NEXT_DATA__\".*?\>(.*?)\<\/script/gm 
                    const match = rx.exec(req_text)

                    if (match && match[1]) {
                        const props = JSON.parse(match[1])
                        if (!props) { this.console.error("Invoice parse failed: ", req_text) }
                        transaction.invoice = props
                    } else {
                        this.console.error("Invoice parse failed: __NEXT_DATA__ not found", req_text)
                    }
                } catch (e) {
                    this.console.error(`Invoice capture is unsuccessful [${this.id}]: `, e)
                }
            }

            return transaction

        }
        ,
        async fetchWithTimeout(url, options, timeoutMs) {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), timeoutMs)
            try {
                return await fetch(url, { ...options, signal: controller.signal })
            } finally {
                clearTimeout(timeout)
            }
        }
        ,
        async page_is_authorised() {

            const c = this.config // const connector_config = {} // DEBUG

            try {
                const auth_request = await fetch(c.auth_check_url, {
                    method: 'GET', credentials: 'include',
                    headers: c.auth_check_headers
                }) 

                const auth_request_json = await auth_request.json()

                if (auth_request?.status !== 200) {
                    this.console.error('Error in the fetch request to coles bff (page_is_authorised). Status: ', auth_request.status) 
                    this.console.log('fetch response: ', JSON.stringify(auth_request_json).slice(0, 2000))
                    return false
                } else {
                    // await this.state.set({auth_state: auth_request_json.authenticated ? "authenticated" : "unauthenticated"})
                    return auth_request_json?.authenticated || false
                }

            } catch (e) {
                this.console.error('error in page_is_authorised: ', e.message)
                return false
            }

        }
        , 
        download_postprocessor(data) {

            let data_normalised 
            if (typeof data === "object") { data = Object.values(data) }

            try {
                data_normalised = data.map(d=>{
                    let ereceipt_data = d.ereceipt
                    let items = []

                    if (ereceipt_data) {

                        try {
                            items = Object.values(ereceipt_data.items)
                            items = items?.map(d=>{return {item_total: d.orderItem?.itemTotalPrice || d.itemTotalPrice, product: d.name || d.product?.name, 
                                unit: d.orderItem?.hasOwnProperty('weight') ? "kg" : "ea", 
                                quantity: (d.orderItem?.hasOwnProperty('weight') ? d.orderItem?.weight : d.orderItem?.quantity) || d.quantity, 
                                unit_price: d.orderItem?.unitPrice || d.itemTotalPrice,
                                sku: d.id || d.productId
                                }
                            })
                        } catch (e) {
                                this.console.error('error in items parsing (download postprocessor): ', e)
                                items = []
                        }
                    }

                    return {
                        transactionId: d.transactionId || d.orderId,
                        card: ereceipt_data.orderAttributes?.flybuysNumber,
                        transactionTime: new Date(ereceipt_data.orderPlacementTime || ereceipt_data.orderAttributes?.orderPlacementTime).toISOString(), 
                        store_name: ereceipt_data.storeName, 
                        store_number: ereceipt_data.store?.storeId, 
                        total: ereceipt_data.orderAttributes?.orderTotalPrice, 
                        points: ereceipt_data.orderAttributes?.flybuysPointsEarned, 
                        items: items
                    }
                })
            } catch (e) {
                this.console.error('error in download preprocessor: ', e)
                data_normalised = undefined
            }

            return { 
                brand: this.id, 
                metabrand: this.id,
                captureTime: (new Date()).toISOString(), 
                ver: this.ver,
                connector_ver: this.ver,
                customer_id: this.customer_id,
                customer_id_type: "barcode",
                download: data,
                normalised_data: data_normalised
            }
        },
        async get_customer_id() {
            const colData = (await this.get_site_variable("colData")) || []
            this.console.debug("colData: ", JSON.stringify(colData), typeof colData)
            try {
                const id = colData.filter(e=>e.event==='customer_summary')?.[0]?.data?.customer?.colesIdBarcode
                this.console.debug("customer_id: ", id)
                if (id) {
                    this.customer_id = id
                } 
                else {
                    this.customer_id = undefined
                }
                return id
            } catch (e) {
                this.console.error('error in get_customer_id: ', e.message)
                return undefined
            }
        },
        async coles_credentials() {

            const next_buildId_cached = this.cache.has("next_buildId") ? this.cache.get("next_buildId") : undefined
            
            if (next_buildId_cached) {
                return { next_buildId: next_buildId_cached }
            }

            const next_data = await this.get_site_variable("__NEXT_DATA__")

            let next_buildId = next_data?.buildId

            if (next_buildId) {
                this.cache.set("next_buildId", next_buildId)
                return { next_buildId: next_buildId }
            }

            const c = this.config // const connector_config = {} 

            if (c.next_buildId) {
                return { next_buildId: c.next_buildId }
            }

            return { next_buildId: this.defaultConnectorConfig?.config?.next_buildId }
        },
    }
}




async function inject_iframe(url) {

    const existing_iframe = document.getElementById("coles_invoice_iframe")

    if (existing_iframe) {
        existing_iframe.src = url
        return existing_iframe
    } else{
        const iframe = document.createElement('iframe')
        iframe.src = url
        iframe.id = "coles_invoice_iframe"
        document.body.appendChild(iframe)
        return iframe
    }
}


