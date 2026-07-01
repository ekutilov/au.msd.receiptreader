import defaultConnectorConfig from "./config.js"

export default function(obj) {

    return {

        ...defaultConnectorConfig,

        async get_transactions(filter=()=>{}) {

            const c = this.config

            let limit_fetch_errors = c.limit_fetch_errors 

            const credentials = await this._credentials()

            const { access_token, client_id } = credentials

            if (!access_token || !client_id) { this.console.error("Credentials not provided (get_transactions)"); return [] }

            let file = []

            let nextPageToken = c.transactions_first_page_token 
            let response;

            do {
                try {
                    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000));

                    response = await Promise.race([ 
                       fetch(c.transactions_graphql_url, {
                                    method: 'POST',
                                    headers: {
                                        'client_id': client_id,
                                        'authorization': "Bearer " + access_token,
                                        'Content-Type': 'application/json; charset=utf-8'
                                    },
                                    body: c.activity_query.replace('FIRST_PAGE', nextPageToken)
                    }),
                    timeout
                    ]);

                    if (response?.status!==200) { return this.console.error("non-200 fetch status ", response.statusText, JSON.stringify(response)) }

                    let response_parsed = await response?.json()

                    nextPageToken = response_parsed?.data?.rtlRewardsActivityFeed?.list?.nextPageToken

                    file = file.concat(response_parsed?.data?.rtlRewardsActivityFeed?.list?.groups?.map(x => x.items?.map((z) =>{ return {...z, title: x.title, clientId: client_id}} )).flat())
                    
                } catch (e) { 

                    this.console.error("Error in fetch (receipts list function): ", JSON.stringify(e), " limit_fetch_errors: ", limit_fetch_errors, " nextPageToken: ", nextPageToken) 
                    limit_fetch_errors--
                    if (limit_fetch_errors<=0) { this.console.error("Too many fetch errors") ; return file}

                }        

            } while (nextPageToken)

            return file
        }
        ,
        async get_ereceipt(transaction_obj) {

            const id = transaction_obj?.receipt
            if (!id) { return {} }

            const c = this.config
        
            let credentials = await this._credentials()
        
            const { access_token, client_id } = credentials
            
            if (!access_token || !client_id) { this.console.error("Credentials not provided (get_ereceipt)"); return {} }
                
            try {
                let response = await fetch(c.receipt_graphql_url, {
                                method: 'POST',
                                headers: {
                                    'client_id': client_id,
                                    'authorization': "Bearer " + access_token,
                                    'Content-Type': 'application/json; charset=utf-8'
                                },
                                body: c.receipt_query.replace('RECEIPT_ID', btoa(JSON.stringify(id)))
                })
        
                if (response?.status!==200) { this.console.error("Non-zero fetch return code: ", response.statusText, JSON.stringify(response)) ; return {} }
        
                let response_parsed = await response?.json()

                return response_parsed?.data

            } catch (e) { 

                this.console.error("Error in fetch (receipt function): ", JSON.stringify(e), " id: ", id )
                return {}
            
            }

        }
        ,
        async _credentials() {

            const c = this.config

            const cookie = await this._getCookie({name: c.auth_cookie_name, url: c.auth_cookie_url})

            if (!cookie) { return }

            // "8h41mMOiDULmlLT28xKSv5ITpp3XBRvH" // TODO: get it from config

            return { client_id: c.defaultClientId, access_token: cookie.value } // result[0].result
        }
        ,
        download_postprocessor(download_data) {

            var data_normalised 

            try {
                data_normalised = download_data.map(
                    (x) => {

                        const day = x.displayDate?.split(" ")[1] || '1'
                        let month, year
                        if (x.title?.includes("This Month")) { month = new Date().toLocaleString('default', { month: 'long' }); year = new Date().getFullYear() }
                        else if (x.title.includes("Last Month")) { month = (new Date(new Date() - 2624016000)).toLocaleString('default', { month: 'long' }); year = (new Date(new Date() - 2624016000)).getFullYear() }
                        else { month = x.title.split(" ")[0]; year = x.title.split(" ")[1] }

                        const transaction_ts = new Date(`${year}-${(new Date(Date.parse(month + " 1")).getMonth() + 1).toString().padStart(2,'0')}-${day.toString().padStart(2,'0')}T12:00:00`).toISOString()
                        let store = x.ereceipt?.activityDetails?.tabs[0]?.page?.details?.filter((x) => x.__typename=="ReceiptDetailsHeader")[0]

                        if (!store) { store = x.ereceipt?.activityDetails?.tabs[0]?.page?.cards
                            ?.filter(card=>card.__typename==="OnlineReceiptHeaderCard")[0]

                            if (store) store.title = store?.heading 
                        }

                        const storename = x.transaction?.origin
                        const total = x.transaction?.amountAsDollars
                        const id = x.id

                        // const transaction_ts = x.displayDate + " " + x.title // .split(" ")[1]).toISOString()

                        let items = x.ereceipt?.activityDetails?.tabs[0]?.page?.details?.filter((x) => x.__typename=="ReceiptDetailsItems")[0]?.items

                        if (items)  {
                            items = items.map( x=> { return {item_total: x.amount, product: x.description, unit: 'ea', quantity: 1, unit_price: x.amount} } )
                        }   else {
                            items = x.ereceipt?.activityDetails?.tabs[0]?.page?.cards
                                ?.filter(card=>card.__typename==="OnlineReceiptDepartmentCard")[0]
                                ?.departmentBlocks?.map((block)=>{ const dept = block.department.description; return block.departmentItems.map(i=>{return {...i, dept: dept }}) })
                                .flat().map(x=>{return {item_total: x.value, product: x.description, unit: 'ea', quantity: 1, unit_price: x.value, sku: undefined}})
                        }
                        
                        return { transaction_id: id, card: x.clientId, transactionTime: transaction_ts, store_name: storename, store_number: store?.storeNo, total:total, points: 0, items: items}
                    })


            } catch (e) {
                this.console.error("Error in download preprocessor: ", e)
            }
            return { 
                brand: this.id, 
                metabrand: this.id,
                captureTime: (new Date()).toISOString(), 
                ver: this.ver,
                customer_id: this.customer_id,
                customer_id_type: "loyalty card",
                connector_ver: this.ver,
                download: download_data,
                normalised_data: data_normalised
            }
        }
        ,
        async get_customer_id() {

            const credentials = await this._credentials()

            try {
                const { access_token, client_id } = credentials
                const f = await fetch("https://api.everyday.com.au/wx/v1/member/accounts/rewards/cards", {
                    "headers": {
                        "accept": "application/json, text/plain, /",
                        "accept-language": "en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
                        "api-version": "2",
                        "authorization": `Bearer ${access_token}`,
                        "cache-control": "no-cache",
                        "client_id": client_id,
                    },
                    "referrer": "https://www.everyday.com.au/",
                    "method": "GET",
                    "credentials": "include"
                    });

                if (f.status!==200) { this.console.error("Error in get_customer_id: ", f.statusText, f) ; return undefined }

                const d = await f.json()

                const id = d?.data?.cards?.[0]?.number

                if (id) { this.customer_id = id }

                return id
            } catch (e) {
                this.console.error("Error in get_customer_id: ", e)
                return undefined
            }
        }
        ,
        async page_is_authorised() {

            const c = this.config

            const cookie = await this._getCookie({url: c.auth_cookie_url, name: c.auth_cookie_name})

            if (cookie && cookie.expires > Date.now()/1000) {
                // await this.state.set({auth_state: "authenticated" })
                return true 
            }

            // await this.state.set({auth_state:  "unauthenticated" })
            return false
        }
        ,
        async _getCookie(a) {

            const cookie = await cookieStore.get(a.name) // TODO: handle multiple cookies with the same name

            return cookie
        }

    }
}
