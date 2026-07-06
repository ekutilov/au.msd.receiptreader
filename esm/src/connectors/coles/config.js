export default {
    enabled: true,
    name: "Coles",
    id: "coles",
    description: "Coles Supermarkets",
    short_description: "Coles",
    doc: "",
    url_match_pattern: ["*://*.coles.com.au/*"],
    ver: "3.2.0",

    config: {
        receipts_bff_link_short: 'https://apigw.coles.com.au/digital/colesappbff/v3/api/1/transactionHistory?limit=5&page=1&inStoreOnly=false&includeWATobacco=true',
        receipts_bff_link: 'https://apigw.coles.com.au/digital/colesappbff/v3/api/1/transactionHistory?limit=50&page=PAGENUMBER&inStoreOnly=false&includeWATobacco=true',
        receipts_api_headers: {
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'same-origin',
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': 'dd6ae58532d743978508555a59a199ac',
            'Accept-Language': 'en-AU;q=1',
            'accept': '*/*'
        },
        transaction_bff_link: 'https://apigw.coles.com.au/digital/colesappbff/v3/api/1/transactionHistory/TRANSACTIONID',
        transaction_api_headers: {
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'same-origin',
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': 'dd6ae58532d743978508555a59a199ac',
            'Accept-Language': 'en-AU;q=1',
            'accept': '*/*'
        },
        auth_launch_link: 'https://auth.colesgroupprofile.com.au/authorize?audience=customer-services&state=vQmnMlNvGNjyGsqgHk2cIdyTnvyCT01ZlcG73CAdk0M&response_type=code&scope=openid%20read:profile%20offline_access%20update:loyalty-account%20read:loyalty-account%20read:product-list%20update:product-list%20update:preferences%20read:preferences%20update:col%20read:col%20sso:col%20read:address%20update:address%20delete:address&nonce=0Z6YPmab5QYIpoCbGm-X2sLteFy0YlTKrZeFK7-WjE4&code_challenge=0puyUlLlLhu5i_LnunM1yavl-ZQeaiPBjWmX9y075Qc&code_challenge_method=S256&redirect_uri=colesapp://colescallback?code%3D&client_id=xQn4GV9tOBsc4OaAltn6P5l0IDFVlG5H&cid=capp:mobileapps:authentication',
        auth_token_link: 'https://auth.colesgroupprofile.com.au/oauth/token',
        ver: '3.2',
        auth_check_url : 'https://www.coles.com.au/api/bff/auth', // TODO: parametrise!
        auth_check_headers : {  // TODO: parametrise!
            'Content-Type': 'application/json',
            'ocp-apim-subscription-key': 'eae83861d1cd4de6bb9cd8a2cd6f041e',
            'cusp-redirect-uri': 'https://www.coles.com.au/'
        },
        next_buildId: "20250307.01_v4.50.0",
        orders_url: "",
        instore_order_link: "https://www.coles.com.au/_next/data/___NEXTBUILDID___/en/account/orders/in-store/___ORDERID___.json?transactionId=___TRANSACTIONID___&orderId=___ORDERID___",
        transaction_array_path: {
            online: ["getOrders({\"status\":\"in-store\"})", "data", "orders"],
            past: ["getOrders({\"status\":\"past\"})", "data", "orders"],
            active: ["getOrders({\"status\":\"active\"})", "data", "orders"] 
        }
        ,
        ereceipt_array_path: {
            default: []
        }
        ,
        transactions_instore_url: "https://www.coles.com.au/api/bff/orders?status=in-store&pageNumber=___PAGENUMBER___&pageSize=50",
        transactions_instore_request_headers: {
            'Content-Type': 'application/json',
            'ocp-apim-subscription-key': 'eae83861d1cd4de6bb9cd8a2cd6f041e'
        },
        transactions_instore_node: ["orders"],
        transactions_online_url: "https://www.coles.com.au/api/bff/orders?status=past&pageNumber=___PAGENUMBER___&pageSize=50",
        transactions_online_request_headers: {
            'Content-Type': 'application/json',
            'ocp-apim-subscription-key': 'eae83861d1cd4de6bb9cd8a2cd6f041e'
        },
        transactions_online_node: ["orders"],
        order_instore_url: "https://www.coles.com.au/_next/data/___NEXTBUILDID___/en/account/orders/in-store/___ORDERID___.json?transactionId=___TRANSACTIONID___&orderId=___ORDERID___",
        order_instore_headers: {
            'Content-Type': 'application/json',
            'ocp-apim-subscription-key': 'eae83861d1cd4de6bb9cd8a2cd6f041e'
        },
        order_instore_node: ["pageProps" , "initialState", "bffApi", "queries", "getOrderV2({\"orderId\":\"___ORDERID___\",\"transactionId\":\"___TRANSACTIONID___\"})", 'data'],
        order_online_url: ["https://www.coles.com.au/api/bff/orders/___ORDERID___", "https://www.coles.com.au/api/bff/orders/___ORDERID___/items"],
        order_online_headers: {
            'Content-Type': 'application/json',
            'ocp-apim-subscription-key': 'eae83861d1cd4de6bb9cd8a2cd6f041e'
        },
        order_online_node: [],
        order_invoice_url: "https://www.coles.com.au/account/orders/___ORDERID___/invoice/___INVOICE_NAME___?transactionId=___INVOICE_NAME___",
        order_invoice_headers: { 
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'cache-control':'no-cache',
            'content-type':'text/html; charset=UTF-8',
            'ocp-apim-subscription-key': undefined,
        }
        ,
        limit_fetch_errors: 8,
    },

}