import defaultConnectorConfig from "./config.js"

export default function() {
    return {

        ...defaultConnectorConfig,

        async get_transactions(filter={}) {
            // get instore transactions
            const c = this.config
            const graphql_endpoint = c.graphql_endpoint
            const instore_receipt_graphql_query = c.instore_transactions_graphql_query
            const instore_limit = c.instore_limit || 6
            let start_paginator = "null"
            const end_paginator = "null"
            let instore_transactions = []

            const access_token = (await this._credentials()).access_token
            if (!access_token) { return false }


            do {
                const body = instore_receipt_graphql_query.replace(/___LIMIT___/g, instore_limit)
                .replace(/___AFTER___/g, start_paginator==="null" ? "null" : "\""+start_paginator+"\"").replace(/___BEFORE___/g, end_paginator)


                const response = await fetch(graphql_endpoint, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": "Bearer " + access_token,
                    },
                    body: body,
                    credentials: "include",
                })

                const response_json = await response.json()

                if (response.status !== 200) {
                    this.console.error("Error fetching instore transactions", response.statusText)
                    return
                }
                const instore_response = response_json // await response.json()
                
                if (instore_response) {
                    this.console.debug("instore_response", instore_response)
                }

                instore_transactions = instore_transactions.concat(instore_response?.data?.getInStoreReceipts?.items || [])

                const instore_pagination = instore_response?.data?.getInStoreReceipts?.pagination || {}
                const instore_total_count = instore_response?.data?.getInStoreReceipts?.pagination?.totalCount || 0
                start_paginator = instore_response?.data?.getInStoreReceipts?.pagination?.next || null
            } while (start_paginator)


            // get online transactions
            const online_receipt_graphql_query = c.online_transactions_graphql_query
            const online_limit = c.online_limit || 6
            start_paginator = "null"
            let online_transactions = []

            do {
                const body = online_receipt_graphql_query.replace(/___LIMIT___/g, online_limit)
                .replace(/___STARTS_AFTER____/g, start_paginator==="null" ? "null" : "\""+start_paginator+"\"")

                const response = await this.injected_fetch(graphql_endpoint, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": "Bearer " + access_token,
                    },
                    body: body,
                    credentials: "include",
                })
                if (response.status !== 200) {
                    this.console.error("Error fetching online transactions", response.statusText)
                    return
                }
                const online_response = await response.json()
                
                if (online_response) {
                    this.console.debug("online_response", online_response)
                }

                online_transactions = online_transactions.concat(online_response?.data?.getOrdersForCustomer?.orders || [])

                // const online_pagination = online_response?.data?.getOrdersForCustomer?.startsAfter || {}
                // const online_total_count = online_response?.data?.getOrdersForCustomer?.count || 0
                start_paginator =  online_response?.data?.getOrdersForCustomer?.startsAfter || null
            } while (start_paginator)

            return [...instore_transactions, ...online_transactions]

            // check pagination

        },

        async get_ereceipt(transaction_obj) {

            if (transaction_obj.orderHash) {
                // online order
                const c = this.config
                const online_receipt_graphql_query = c.online_receipt_query
                const graphql_endpoint = c.graphql_endpoint
                const access_token = (await this._credentials()).access_token
                if (!access_token) { return false }

                const body = online_receipt_graphql_query.replace(/___HASH___/g, transaction_obj.orderHash)

                const response = await this.injected_fetch(graphql_endpoint, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": "Bearer " + access_token,
                    },
                    body: body,
                    credentials: "include",
                })
                if (response.status !== 200) {
                    this.console.error("Error fetching online receipt", response.statusText)
                    return
                }
                const receipt = await response.json()
                return receipt
            }  else if (transaction_obj.receipt?.webUrl) {
                // instore order
                const c = this.config
                const instore_receipt_request_url = c.instore_receipt_request_url

                const regex = new RegExp(c.weburl_transformer_regex)
                const match = transaction_obj.receipt.webUrl.match(regex)
                const era_hash = match ? match[1] : transaction_obj.receipt.webUrl

                const request_url = instore_receipt_request_url.replace(/___ERA_HASH___/g, era_hash)

                const response = await this.proxied_fetch(request_url, {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    //credentials: "include",
                })
                if (response.status !== 200) {
                    this.console.error("Error fetching instore receipt", response.statusText)
                    return
                }
                const receipt = await response.json()
                return receipt
            } 
            else {
                return {}
            }

            return {}

            // for online orders:
            // use graphql and orderHash attribute to get order details
            // 
            // for instore orders: receipt?.webUrl but replace https://receipts.slyp.com.au with https://api.slyp.com.au/v1/loyalty/web-receipts/

        },
        async page_is_authorised() {
            const site_variable = await this.get_site_variable("localStorage")

            if (!site_variable) { return false }

            const auth_key = Object.keys(site_variable).filter(key => {
                return key.includes("auth0")
                }
            )

            const auth0object = site_variable[auth_key[0]]
            if (!auth0object) { return false }
            const auth0 = JSON.parse(auth0object)
            if (!auth0) { return false }
            const expiry = auth0['expiresAt']
            if (!expiry) { return false }
            const now = new Date().getTime() / 1000
            if (expiry < now) { return false }

            return true
        },
        async _credentials() {

            // check cache first
            if (this.cache.has("credentials")) {
                // check if cached credentials are still valid
                const credentials = this.cache.get("credentials")
                const now = new Date().getTime() / 1000
                if (credentials.expiry > now) {
                    return credentials
                } else {                    this.cache.delete("credentials")
                }
               }

            const site_variable = await this.get_site_variable("localStorage")
            this.console.debug("site_variable ", site_variable)

            if (!site_variable) { return false }

            const auth_key = Object.keys(site_variable).filter(key => {
                return key.includes("auth0")
                }
            )

            const auth0object = site_variable[auth_key[0]]
            if (!auth0object) { return false }
            const auth0 = JSON.parse(auth0object)
            if (!auth0) { return false }

            //cache the credentials for future use
            this.cache.set("credentials", { access_token: auth0.body.accessToken, expiry: auth0.body.expiresAt })

            return auth0?.body
        },
        async get_customer_id() {
            const site_variable = await this.get_site_variable("localStorage")

            if (!site_variable) { return false }

            const auth_key = Object.keys(site_variable).filter(key => {
                return key.includes("auth0")
                }
            )

            const auth0object = site_variable[auth_key[0]]
            if (!auth0object) { return false }
            const auth0 = JSON.parse(auth0object)
            if (!auth0) { return false }

            return auth0?.body?.decodedToken?.user?.nickname || "(unknown)"
        },
    }
}