// src/components/connectorPrototype.js
function connectorPrototype(obj) {
  const defaultRequestTimeout = 9 * 1e3;
  return {
    parent: obj,
    defaultConnectorConfig: {},
    cache: /* @__PURE__ */ new Map(),
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
          const event = new CustomEvent("msd-state-update", { detail: { ...target } });
          window.dispatchEvent(event);
          if (options.onStateChange) {
            options.onStateChange({ ...target });
          }
          return true;
        }
      };
      this.state = new Proxy(initialState, handler);
      this.page_is_authorised().then((isAuth) => {
        this.state.auth_state = isAuth ? "authenticated" : "unauthenticated";
      });
      if (options.onStreamStart) this.onStreamStart = options.onStreamStart;
      if (options.onStreamChunk) this.onStreamChunk = options.onStreamChunk;
      if (options.onStreamCancel) this.onStreamCancel = options.onStreamCancel;
      if (options.onStreamEnd) this.onStreamEnd = options.onStreamEnd;
      if (options.request_timeout) {
        this.request_timeout = options.request_timeout;
      } else {
        this.request_timeout = defaultRequestTimeout;
      }
      if (options.load_config) {
        let config_url = options.load_config;
        let config_online = await fetch(config_url);
        if (config_online.ok) {
          let config_content = await config_online.json();
          this.config = { ...config_content, ...JSON.parse(config_content[this.id]?.config) || {} };
        }
      }
      if (options.config) {
        this.config = options.config;
      }
      this.console.debug("Connector initialized with config: ", this.config);
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
    async pull(filter = {}) {
      obj.store.cancelRun = false;
      this.state.download_status = "in_progress";
      this.state.pc = 0;
      this.state.message = "Checking authorization";
      cc = this.config;
      if (!await this.page_is_authorised()) {
        this.console.error("Attempt to call pull when page is not authorised");
        this.state.download_status = "download_failed";
        this.state.error = "Page is not authorised";
        this.state.message = "Authorization failed";
        return { status: { ...this.state }, content: [] };
      }
      this.state.auth_state = "authenticated";
      this.state.message = "Fetching transactions";
      let max_errors = cc?.max_errors || 5;
      const transactions_1 = await this.get_transactions(filter);
      let transactions;
      if (transactions_1 && Array.isArray(transactions_1)) {
        transactions = transactions_1.filter((el) => el !== null && el !== void 0);
      } else {
        transactions = [];
        this.console.error("get_transactions returned an invalid value: ", transactions_1);
      }
      let length = transactions?.length || 0;
      if (length === 0) {
        this.console.error(`No transactions found or download error: connector: ${this.name}, id: ${this.id}, ver: ${this.app.ver}`);
        this.state.download_status = "download_failed";
        this.state.error = "No transactions found or download error: try to refresh the page";
        this.state.message = "No transactions found";
        return { status: { ...this.state }, content: [] };
      }
      transactions = transactions.sort(() => Math.random() - 0.5);
      this.state.metadata = { total_items: length, current_item: 0 };
      this.state.message = `Found ${length} transactions. Starting download...`;
      const streamStartData = { expected_chunks: length, transactions_index: transactions };
      if (typeof this.onStreamStart === "function") {
        try {
          await this.onStreamStart(streamStartData);
        } catch (e) {
          this.console.error("Error in onStreamStart callback: ", e);
        }
      }
      window.dispatchEvent(new CustomEvent("msd-stream-start", { detail: streamStartData }));
      for (let i = 0; i < length; i++) {
        this.state.pc = i / length * 100;
        this.state.metadata = { ...this.state.metadata, current_item: i + 1 };
        this.state.message = `Downloading receipt ${i + 1} of ${length}`;
        try {
          const timeout = new Promise(
            (_2, reject) => setTimeout(() => reject(new Error("Timeout: get_ereceipt took too long")), this.request_timeout)
          );
          const ereceipt = await Promise.race([this.get_ereceipt(transactions[i]), timeout]);
          transactions[i].ereceipt = ereceipt;
          const streamChunkData = { index: i, expected_chunks: length, chunk: transactions[i] };
          if (typeof this.onStreamChunk === "function") {
            try {
              await this.onStreamChunk(streamChunkData);
            } catch (e) {
              this.console.error("Error in onStreamChunk callback: ", e);
            }
          }
          window.dispatchEvent(new CustomEvent("msd-stream-chunk", { detail: streamChunkData }));
          if (obj.store.cancelRun) {
            this.state.download_status = "download_cancelled";
            this.state.message = "Download cancelled by user";
            this.console.log("Download cancelled by user request");
            const streamCancelData = { index: i, expected_chunks: length };
            if (typeof this.onStreamCancel === "function") {
              try {
                await this.onStreamCancel(streamCancelData);
              } catch (e) {
                this.console.error("Error in onStreamCancel callback: ", e);
              }
            }
            window.dispatchEvent(new CustomEvent("msd-stream-cancel", { detail: streamCancelData }));
            return { status: { ...this.state }, content: transactions };
          }
        } catch (e) {
          this.console.error(`Error in ereceipt scraper [${this.id}]: `, e, transactions[i]);
          transactions[i].ereceipt_status = { error: JSON.stringify(e) };
          if (max_errors-- < 0) {
            this.console.error(`Too many fetch errors in ereceipt scraper [${this.id}]: `, e);
            this.state.download_status = "download_failed";
            this.state.error = "Too many errors when fetching data";
            this.state.message = "Download failed due to too many errors";
            const streamCancelData = { index: i, expected_chunks: length, reason: "too_many_errors", error: e.message || JSON.stringify(e) };
            if (typeof this.onStreamCancel === "function") {
              try {
                await this.onStreamCancel(streamCancelData);
              } catch (err) {
                this.console.error("Error in onStreamCancel callback: ", err);
              }
            }
            window.dispatchEvent(new CustomEvent("msd-stream-cancel", { detail: streamCancelData }));
            return { status: { ...this.state }, content: transactions };
          }
        }
      }
      this.state.pc = 100;
      this.state.message = "Finalizing download";
      const length_success = transactions.filter((el) => el.ereceipt)?.length || 0;
      const customer_id = await this.get_customer_id();
      if (transactions.length > 0) {
        transactions[0].scraper = { clientId: customer_id, ver: this.config.ver, captureTime: (/* @__PURE__ */ new Date()).toISOString() };
      }
      const processed_data = this.download_postprocessor(transactions);
      this.state.download_status = "completed";
      this.state.message = "Download completed successfully";
      this.state.metadata = { ...this.state.metadata, ereceipts_count: length_success };
      const streamEndData = { expected_chunks: length, total_success: length_success };
      if (typeof this.onStreamEnd === "function") {
        try {
          await this.onStreamEnd(streamEndData);
        } catch (e) {
          this.console.error("Error in onStreamEnd callback: ", e);
        }
      }
      window.dispatchEvent(new CustomEvent("msd-stream-end", { detail: streamEndData }));
      return { status: { ...this.state }, content: transactions };
    },
    async page_is_authorised() {
      return false;
    },
    async get_customer_id() {
      return "undefined";
    },
    async get_transactions() {
      return [];
    },
    async get_transaction_count() {
      this.state.message = "Checking transactions";
      const transactions_1 = await this.get_transactions();
      let transactions;
      if (transactions_1 && Array.isArray(transactions_1)) {
        transactions = transactions_1.filter((el) => el !== null && el !== void 0);
      } else {
        transactions = [];
        this.console.error("get_transactions returned an invalid value: ", JSON.stringify({ value: transactions_1 }));
      }
      const count = transactions?.length || 0;
      this.state.message = `Found ${count} transactions`;
      return count;
    },
    async get_ereceipt(t) {
      const id = t?.id || "id";
      return {};
    },
    async get_site_variable(key) {
      return window[key];
    },
    async injected_fetch(url, options) {
      return fetch(url, options);
    },
    download_postprocessor(data) {
      return {
        brand: this.id,
        metabrand: this.id,
        captureTime: (/* @__PURE__ */ new Date()).toISOString(),
        ver: this.ver,
        connector_ver: this.ver,
        download: data,
        normalised_data: void 0
      };
    },
    getJSONnode(data, node) {
      if (typeof data === "object") {
        data = Object.values(data);
      }
      if (typeof data === "string") {
        data = JSON.parse(data);
      }
      if (typeof node === "string") {
        node = [node];
      }
      if (typeof node === "object") {
        for (let i = 0; i < node.length; i++) {
          const n = node[i];
          if (data[n]) {
            data = data[n];
          } else {
            console.error("Node not found", n);
            return void 0;
          }
        }
      }
      return data;
    },
    proxied_fetch: async function(url, options) {
      const c = this.config;
      if (!c.proxy) {
        return false;
      }
      const proxy_url = c.proxy + url;
      const proxy_secret = c.proxy_secret;
      if (!proxy_secret) {
        return false;
      }
      const response = await fetch(proxy_url, {
        ...options,
        headers: {
          ...options.headers,
          "x-target-url": url,
          "x-proxy-secret": proxy_secret
        }
      });
      return response;
    }
  };
}

// src/connectors/everyday/config.js
var config_default = {
  enabled: true,
  name: "Woolworths",
  id: "woolworths",
  description: "Everyday Rewards (Woolworths, BWS, Woolworths Metro)",
  short_description: "Everyday Rewards (Woolworths Group)",
  doc: "",
  url_match_pattern: ["*://*.everyday.com.au/*"],
  ver: "3.3.0",
  config: {
    transactions_graphql_url: "https://apigee-prod.api-wr.com/wx/v1/bff/graphql",
    receipt_graphql_url: "https://apigee-prod.api-wr.com/wx/v1/bff/graphql",
    transactions_first_page_token: "FIRST_PAGE",
    ver: "3.2",
    activity_query: '{"variables": {"featureFlags": { "activityBreakdown": true, "activityBreakdownOnboarding": true }, "page": "FIRST_PAGE", "enableOnlineReceipt": true     }, "query": "query($page:String!$enableOnlineReceipt:Boolean$featureFlags:RewardsActivityFeedFeatureFlags!){rtlRewardsActivityFeed(pageToken:$page,featureFlags:$featureFlags){list{groups{...on RewardsActivityBanner{__typename id iconUrl title message messageCta action{url type}onDismissCoachMark{text anchor}analytics{label}}...on RewardsActivityFeedGroup{__typename id title items{id displayDate description message displayValue displayValueHandling icon iconUrl transaction{origin amountAsDollars}highlights{iconUrl description value style}receipt(enableOnlineReceipt:$enableOnlineReceipt){receiptId receiptSource}transactionType actionURL showChevron}}}nextPageToken}}}"}',
    receipt_query: '{"variables": {"id":"RECEIPT_ID"},"query":"query($id:String!){activityDetails(id:$id){__typename defaultTabSelection tabs{__typename navigationTitle navigationTitleAltText label page{...on ActivityBreakdown{__typename cards{...on ActivityBreakdownCardTotalPoints{__typename pointsTitle pointsSubtitle pointsIconUrl locationTitle locationIconUrl altText}...on ActivityBreakdownCardPoints{__typename pointsHeader{bonusPoints{value description note}basePoints{value description note}altText}pointsLineItems{title description iconUrl campaignCode altText altHint}accordionOffset}...on ActivityBreakdownCardBenefitsEnjoyed{__typename benefitsTitle benefitsLineItems{title subtitle iconUrl altText}accordionOffset}...on ActivityBreakdownCardHelp{__typename helpTitle helpNote helpCta{__typename label url}}}}...on ReceiptDetails{__typename download{url filename}details{...on ReceiptDetailsHeader{__typename iconUrl title content storeNo division}...on ReceiptDetailsTotal{__typename total}...on ReceiptDetailsSavings{__typename savings}...on ReceiptDetailsFooter{__typename barcode{value type}transactionDetails abnAndStore}...on ReceiptDetailsItems{__typename header{...receiptLineItem}items{...receiptLineItem}}...on ReceiptDetailsSummary{__typename discounts{...receiptLineItem}summaryItems{...receiptLineItem}gst{...receiptLineItem}receiptTotal{...receiptLineItem}}...on ReceiptDetailsPayments{__typename payments{details{text}description iconUrl altText amount}}...on ReceiptDetailsInfo{__typename header{...receiptLineItem}info{...receiptLineItem}}...on ReceiptDetailsCoupon{__typename headerImageUrl sections{sectionTitle details}footer barcode{value type}}}}...on OnlineReceiptDetails{__typename download{url filename}cards{...on OnlineReceiptHeaderCard{__typename iconUrl heading subheading}...on OnlineReceiptTotalCard{__typename total}...on OnlineReceiptOrderCard{__typename title{__typename description value}orderItems{__typename description value indentLevel strikethrough}}...on OnlineReceiptDepartmentCard{__typename proofOfAge{__typename description value}description{__typename description value}departmentBlocks{__typename department{__typename description value}departmentItems{__typename description value indentLevel strikethrough}}}...on OnlineReceiptSubstitutionsCard{__typename title{__typename description value}totalCount description{__typename description value}substitutionItems{__typename description value indentLevel strikethrough}footer}...on OnlineReceiptOutOfStockCard{__typename title{__typename description value}totalCount description{__typename description value}outOfStockItems{__typename description value indentLevel strikethrough}footer}...on OnlineReceiptSummaryCard{__typename subtotal{__typename subtotalItems{__typename description value indentLevel strikethrough}}invoiceTotal{__typename invoiceTotalDescription invoiceTotalValue gstDescription gstValue invoiceTotalItems{__typename description value indentLevel strikethrough}}}...on OnlineReceiptNoteCard{__typename notes}}}...on ActivityDetailsTabError{__typename title message enableRetry}}}}}fragment receiptLineItem on ReceiptDetailsLineItem{prefixChar description amount}"}',
    auth_cookie_url: "https://www.everyday.com.au",
    auth_cookie_name: "authStatusData",
    defaultClientId: "8h41mMOiDULmlLT28xKSv5ITpp3XBRvH",
    login_link: "https://www.everyday.com.au/login",
    limit_fetch_errors: 5
  }
};

// src/connectors/everyday/connector.js
function connector_default(obj) {
  return {
    ...config_default,
    async get_transactions(filter = () => {
    }) {
      const c = this.config;
      let limit_fetch_errors = c.limit_fetch_errors;
      const credentials = await this._credentials();
      const { access_token, client_id } = credentials;
      if (!access_token || !client_id) {
        this.console.error("Credentials not provided (get_transactions)");
        return [];
      }
      let file = [];
      let nextPageToken = c.transactions_first_page_token;
      let response;
      do {
        try {
          const timeout = new Promise((_2, reject) => setTimeout(() => reject(new Error("Timeout")), 1e4));
          response = await Promise.race([
            fetch(c.transactions_graphql_url, {
              method: "POST",
              headers: {
                "client_id": client_id,
                "authorization": "Bearer " + access_token,
                "Content-Type": "application/json; charset=utf-8"
              },
              body: c.activity_query.replace("FIRST_PAGE", nextPageToken)
            }),
            timeout
          ]);
          if (response?.status !== 200) {
            return this.console.error("non-200 fetch status ", response.statusText, JSON.stringify(response));
          }
          let response_parsed = await response?.json();
          nextPageToken = response_parsed?.data?.rtlRewardsActivityFeed?.list?.nextPageToken;
          file = file.concat(response_parsed?.data?.rtlRewardsActivityFeed?.list?.groups?.map((x2) => x2.items?.map((z2) => {
            return { ...z2, title: x2.title, clientId: client_id };
          })).flat());
        } catch (e) {
          this.console.error("Error in fetch (receipts list function): ", JSON.stringify(e), " limit_fetch_errors: ", limit_fetch_errors, " nextPageToken: ", nextPageToken);
          limit_fetch_errors--;
          if (limit_fetch_errors <= 0) {
            this.console.error("Too many fetch errors");
            return file;
          }
        }
      } while (nextPageToken);
      return file;
    },
    async get_ereceipt(transaction_obj) {
      const id = transaction_obj?.receipt;
      if (!id) {
        return {};
      }
      const c = this.config;
      let credentials = await this._credentials();
      const { access_token, client_id } = credentials;
      if (!access_token || !client_id) {
        this.console.error("Credentials not provided (get_ereceipt)");
        return {};
      }
      try {
        let response = await fetch(c.receipt_graphql_url, {
          method: "POST",
          headers: {
            "client_id": client_id,
            "authorization": "Bearer " + access_token,
            "Content-Type": "application/json; charset=utf-8"
          },
          body: c.receipt_query.replace("RECEIPT_ID", btoa(JSON.stringify(id)))
        });
        if (response?.status !== 200) {
          this.console.error("Non-zero fetch return code: ", response.statusText, JSON.stringify(response));
          return {};
        }
        let response_parsed = await response?.json();
        return response_parsed?.data;
      } catch (e) {
        this.console.error("Error in fetch (receipt function): ", JSON.stringify(e), " id: ", id);
        return {};
      }
    },
    async _credentials() {
      const c = this.config;
      const cookie = await this._getCookie({ name: c.auth_cookie_name, url: c.auth_cookie_url });
      if (!cookie) {
        return;
      }
      return { client_id: c.defaultClientId, access_token: cookie.value };
    },
    download_postprocessor(download_data) {
      var data_normalised;
      try {
        data_normalised = download_data.map(
          (x2) => {
            const day = x2.displayDate?.split(" ")[1] || "1";
            let month, year;
            if (x2.title?.includes("This Month")) {
              month = (/* @__PURE__ */ new Date()).toLocaleString("default", { month: "long" });
              year = (/* @__PURE__ */ new Date()).getFullYear();
            } else if (x2.title.includes("Last Month")) {
              month = new Date(/* @__PURE__ */ new Date() - 2624016e3).toLocaleString("default", { month: "long" });
              year = new Date(/* @__PURE__ */ new Date() - 2624016e3).getFullYear();
            } else {
              month = x2.title.split(" ")[0];
              year = x2.title.split(" ")[1];
            }
            const transaction_ts = (/* @__PURE__ */ new Date(`${year}-${(new Date(Date.parse(month + " 1")).getMonth() + 1).toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}T12:00:00`)).toISOString();
            let store = x2.ereceipt?.activityDetails?.tabs[0]?.page?.details?.filter((x3) => x3.__typename == "ReceiptDetailsHeader")[0];
            if (!store) {
              store = x2.ereceipt?.activityDetails?.tabs[0]?.page?.cards?.filter((card) => card.__typename === "OnlineReceiptHeaderCard")[0];
              if (store) store.title = store?.heading;
            }
            const storename = x2.transaction?.origin;
            const total = x2.transaction?.amountAsDollars;
            const id = x2.id;
            let items = x2.ereceipt?.activityDetails?.tabs[0]?.page?.details?.filter((x3) => x3.__typename == "ReceiptDetailsItems")[0]?.items;
            if (items) {
              items = items.map((x3) => {
                return { item_total: x3.amount, product: x3.description, unit: "ea", quantity: 1, unit_price: x3.amount };
              });
            } else {
              items = x2.ereceipt?.activityDetails?.tabs[0]?.page?.cards?.filter((card) => card.__typename === "OnlineReceiptDepartmentCard")[0]?.departmentBlocks?.map((block) => {
                const dept = block.department.description;
                return block.departmentItems.map((i) => {
                  return { ...i, dept };
                });
              }).flat().map((x3) => {
                return { item_total: x3.value, product: x3.description, unit: "ea", quantity: 1, unit_price: x3.value, sku: void 0 };
              });
            }
            return { transaction_id: id, card: x2.clientId, transactionTime: transaction_ts, store_name: storename, store_number: store?.storeNo, total, points: 0, items };
          }
        );
      } catch (e) {
        this.console.error("Error in download preprocessor: ", e);
      }
      return {
        brand: this.id,
        metabrand: this.id,
        captureTime: (/* @__PURE__ */ new Date()).toISOString(),
        ver: this.ver,
        customer_id: this.customer_id,
        customer_id_type: "loyalty card",
        connector_ver: this.ver,
        download: download_data,
        normalised_data: data_normalised
      };
    },
    async get_customer_id() {
      const credentials = await this._credentials();
      try {
        const { access_token, client_id } = credentials;
        const f = await fetch("https://api.everyday.com.au/wx/v1/member/accounts/rewards/cards", {
          "headers": {
            "accept": "application/json, text/plain, /",
            "accept-language": "en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
            "api-version": "2",
            "authorization": `Bearer ${access_token}`,
            "cache-control": "no-cache",
            "client_id": client_id
          },
          "referrer": "https://www.everyday.com.au/",
          "method": "GET",
          "credentials": "include"
        });
        if (f.status !== 200) {
          this.console.error("Error in get_customer_id: ", f.statusText, f);
          return void 0;
        }
        const d = await f.json();
        const id = d?.data?.cards?.[0]?.number;
        if (id) {
          this.customer_id = id;
        }
        return id;
      } catch (e) {
        this.console.error("Error in get_customer_id: ", e);
        return void 0;
      }
    },
    async page_is_authorised() {
      const c = this.config;
      const cookie = await this._getCookie({ url: c.auth_cookie_url, name: c.auth_cookie_name });
      if (cookie && cookie.expires > Date.now() / 1e3) {
        return true;
      }
      return false;
    },
    async _getCookie(a) {
      const cookie = await cookieStore.get(a.name);
      return cookie;
    }
  };
}

// src/connectors/coles/config.js
var config_default2 = {
  enabled: true,
  name: "Coles",
  id: "coles",
  description: "Coles Supermarkets",
  short_description: "Coles",
  doc: "",
  url_match_pattern: ["*://*.coles.com.au/*"],
  ver: "3.2.0",
  config: {
    receipts_bff_link_short: "https://apigw.coles.com.au/digital/colesappbff/v3/api/1/transactionHistory?limit=5&page=1&inStoreOnly=false&includeWATobacco=true",
    receipts_bff_link: "https://apigw.coles.com.au/digital/colesappbff/v3/api/1/transactionHistory?limit=50&page=PAGENUMBER&inStoreOnly=false&includeWATobacco=true",
    receipts_api_headers: {
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": "dd6ae58532d743978508555a59a199ac",
      "Accept-Language": "en-AU;q=1",
      "accept": "*/*"
    },
    transaction_bff_link: "https://apigw.coles.com.au/digital/colesappbff/v3/api/1/transactionHistory/TRANSACTIONID",
    transaction_api_headers: {
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": "dd6ae58532d743978508555a59a199ac",
      "Accept-Language": "en-AU;q=1",
      "accept": "*/*"
    },
    auth_launch_link: "https://auth.colesgroupprofile.com.au/authorize?audience=customer-services&state=vQmnMlNvGNjyGsqgHk2cIdyTnvyCT01ZlcG73CAdk0M&response_type=code&scope=openid%20read:profile%20offline_access%20update:loyalty-account%20read:loyalty-account%20read:product-list%20update:product-list%20update:preferences%20read:preferences%20update:col%20read:col%20sso:col%20read:address%20update:address%20delete:address&nonce=0Z6YPmab5QYIpoCbGm-X2sLteFy0YlTKrZeFK7-WjE4&code_challenge=0puyUlLlLhu5i_LnunM1yavl-ZQeaiPBjWmX9y075Qc&code_challenge_method=S256&redirect_uri=colesapp://colescallback?code%3D&client_id=xQn4GV9tOBsc4OaAltn6P5l0IDFVlG5H&cid=capp:mobileapps:authentication",
    auth_token_link: "https://auth.colesgroupprofile.com.au/oauth/token",
    auth_token_formbody: {
      "code_verifier": "4RVfTXD1GZRTT3xJYESG-08AEVNqs-77EVE3dPfyVjc",
      "redirect_uri": "colesapp://colescallback?code=",
      "client_id": "xQn4GV9tOBsc4OaAltn6P5l0IDFVlG5H",
      "grant_type": "authorization_code"
    },
    refresh_token_formbody: {
      "client_id": "xQn4GV9tOBsc4OaAltn6P5l0IDFVlG5H",
      "scope": "openid read:profile offline_access update:loyalty-account read:loyalty-account read:product-list update:product-list update:preferences read:preferences update:col read:col sso:col read:address update:address delete:address",
      "grant_type": "refresh_token",
      "redirect_uri": "colesapp://colescallback?code=",
      "audience": "customer-services",
      "cid": "capp:mobileapps:authentication"
    },
    ver: "3.2",
    auth_check_url: "https://www.coles.com.au/api/bff/auth",
    // TODO: parametrise!
    auth_check_headers: {
      // TODO: parametrise!
      "Content-Type": "application/json",
      "ocp-apim-subscription-key": "eae83861d1cd4de6bb9cd8a2cd6f041e",
      "cusp-redirect-uri": "https://www.coles.com.au/"
    },
    next_buildId: "20250307.01_v4.50.0",
    orders_url: "",
    instore_order_link: "https://www.coles.com.au/_next/data/___NEXTBUILDID___/en/account/orders/in-store/___ORDERID___.json?transactionId=___TRANSACTIONID___&orderId=___ORDERID___",
    transaction_array_path: {
      online: ['getOrders({"status":"in-store"})', "data", "orders"],
      past: ['getOrders({"status":"past"})', "data", "orders"],
      active: ['getOrders({"status":"active"})', "data", "orders"]
    },
    ereceipt_array_path: {
      default: []
    },
    transactions_instore_url: "https://www.coles.com.au/api/bff/orders?status=in-store&pageNumber=___PAGENUMBER___&pageSize=50",
    transactions_instore_request_headers: {
      "Content-Type": "application/json",
      "ocp-apim-subscription-key": "eae83861d1cd4de6bb9cd8a2cd6f041e"
    },
    transactions_instore_node: ["orders"],
    transactions_online_url: "https://www.coles.com.au/api/bff/orders?status=past&pageNumber=___PAGENUMBER___&pageSize=50",
    transactions_online_request_headers: {
      "Content-Type": "application/json",
      "ocp-apim-subscription-key": "eae83861d1cd4de6bb9cd8a2cd6f041e"
    },
    transactions_online_node: ["orders"],
    order_instore_url: "https://www.coles.com.au/_next/data/___NEXTBUILDID___/en/account/orders/in-store/___ORDERID___.json?transactionId=___TRANSACTIONID___&orderId=___ORDERID___",
    order_instore_headers: {
      "Content-Type": "application/json",
      "ocp-apim-subscription-key": "eae83861d1cd4de6bb9cd8a2cd6f041e"
    },
    order_instore_node: ["pageProps", "initialState", "bffApi", "queries", 'getOrderV2({"orderId":"___ORDERID___","transactionId":"___TRANSACTIONID___"})', "data"],
    order_online_url: ["https://www.coles.com.au/api/bff/orders/___ORDERID___", "https://www.coles.com.au/api/bff/orders/___ORDERID___/items"],
    order_online_headers: {
      "Content-Type": "application/json",
      "ocp-apim-subscription-key": "eae83861d1cd4de6bb9cd8a2cd6f041e"
    },
    order_online_node: [],
    order_invoice_url: "https://www.coles.com.au/account/orders/___ORDERID___/invoice/___INVOICE_NAME___?transactionId=___INVOICE_NAME___",
    order_invoice_headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "cache-control": "no-cache",
      "content-type": "text/html; charset=UTF-8",
      "ocp-apim-subscription-key": void 0
    },
    limit_fetch_errors: 8
  }
};

// src/connectors/coles/connector.js
function connector_default2(obj) {
  return {
    ...config_default2,
    async get_transactions(filter = {}) {
      const c = this.config;
      this.console.debug("Coles scraper get_transactions is called ");
      const next_buildId = (await this.coles_credentials())?.next_buildId || c.next_buildId;
      this.console.log("next_buildId: ", next_buildId);
      let stop_flag = false;
      let transactions = [];
      let page = 1;
      let error_counter = c.limit_fetch_errors;
      let req;
      let timeout = 600;
      while (!stop_flag) {
        try {
          req = await this.fetchWithTimeout(
            c.transactions_instore_url.replaceAll("___NEXTBUILDID___", next_buildId).replaceAll("___PAGENUMBER___", page),
            {
              method: "GET",
              headers: c.transactions_instore_request_headers,
              credentials: "include",
              withCredentials: true,
              mode: "cors"
            },
            1e4
          );
          this.console.debug("fetch response: ", JSON.stringify(req));
          if (req?.status !== 200) {
            this.console.error("Error in the fetch request to coles get_transactions (instore). Status: ", req?.status, "fetch response: ", JSON.stringify(req).slice(0, 2e3), "req.statusText: ", req?.statusText);
          }
          let page_content = await req.json();
          for (const key of c.transactions_instore_node) {
            page_content = page_content[key] || [];
          }
          if (page_content.length === 0) {
            stop_flag = true;
          } else {
            page_content = page_content.map((d) => {
              return { _order_type: "instore", ...d };
            });
            transactions = transactions.concat(page_content);
            page++;
          }
        } catch (e) {
          this.console.error("error in coles transactions scraper: ", e);
          timeout = timeout + 400;
          if (error_counter-- === 0) {
            stop_flag = true;
          }
        }
        await new Promise((r) => setTimeout(r, timeout));
      }
      stop_flag = false;
      page = 1;
      error_counter = c.limit_fetch_errors;
      timeout = 600;
      while (!stop_flag) {
        try {
          req = await this.fetchWithTimeout(
            c.transactions_online_url.replaceAll("___NEXTBUILDID___", next_buildId).replaceAll("___PAGENUMBER___", page),
            {
              method: "GET",
              headers: c.transactions_online_request_headers,
              credentials: "include"
            },
            7e3
          );
          if (req?.status !== 200) {
            this.console.error("Error in the fetch request to coles bff (get_transactions, online). Status: ", req?.status, "fetch response: ", JSON.stringify(req));
          }
          let page_content = await req.json();
          for (const key of c.transactions_online_node) {
            page_content = page_content[key] || [];
          }
          if (page_content.length === 0) {
            stop_flag = true;
          } else {
            transactions = transactions.concat(page_content.map((d) => {
              return { _order_type: "online", ...d };
            }));
            page++;
          }
        } catch (e) {
          this.console.error("Error in transactions scraper (online): ", e?.message);
          timeout = timeout + 400;
          if (error_counter-- === 0) {
            stop_flag = true;
          }
        }
        await new Promise((r) => setTimeout(r, timeout));
      }
      return transactions;
    },
    async get_ereceipt(transaction_obj) {
      if (!transaction_obj) {
        this.console.error("get_ereceipt: transaction_obj is not valid: ", JSON.stringify({ obj: transaction_obj }));
        return;
      }
      this.console.log("get_ereceipt: transaction_obj: ", JSON.stringify(transaction_obj));
      const c = this.config;
      const next_buildId = (await this.coles_credentials())?.next_buildId || c.next_buildId;
      let order_url, order_headers, order_node;
      if (transaction_obj._order_type === "online") {
        order_url = c.order_online_url;
        order_headers = c.order_online_headers;
        order_node = c.order_online_node;
      } else {
        order_url = c.order_instore_url;
        order_headers = c.order_instore_headers;
        order_node = c.order_instore_node;
      }
      if (typeof order_url === "string") {
        order_url = [order_url];
      }
      order_url = order_url.map((d) => d.replaceAll("___NEXTBUILDID___", next_buildId).replaceAll("___ORDERID___", transaction_obj.orderId).replaceAll("___TRANSACTIONID___", transaction_obj.transactionId));
      let transaction = {};
      let req;
      for (const url of order_url) {
        req = await this.fetchWithTimeout(
          url,
          {
            method: "GET",
            headers: order_headers,
            credentials: "include"
          },
          7e3
        );
        if (!req) {
          this.console.error("Error in the fetch request - likely a timeout (get_ereceipt).");
          return;
        }
        if (req.status !== 200) {
          this.console.error("Error in the fetch request to coles bff (get_ereceipt). Status: ", req.status, "fetch response: ", JSON.stringify(req));
          return;
        }
        let page_content = await req.json();
        for (const key of order_node) {
          page_content = page_content[key.replaceAll("___ORDERID___", transaction_obj.orderId).replaceAll("___TRANSACTIONID___", transaction_obj.transactionId)];
          page_content = page_content || [];
        }
        transaction = { ...transaction, ...page_content };
        await new Promise((r) => setTimeout(r, 750));
      }
      if (transaction_obj._order_type === "online") {
        try {
          const timeout = new Promise(
            (_2, reject) => setTimeout(() => reject(new Error("Timeout: fetch request took too long")), 7e3)
            // 5 seconds timeout
          );
          const invoice_name = Object.values(transaction?.orderAttributes?.invoices).filter((e) => e.format == "HTML")?.[0]?.fileName.match(/(.*)\.xml/)[1];
          this.console.debug("invoice_name: ", invoice_name);
          const invoice_url = c.order_invoice_url.replaceAll("___ORDERID___", transaction_obj.orderId).replaceAll("___INVOICE_NAME___", invoice_name);
          await new Promise((r) => setTimeout(r, 300));
          const options = {
            method: "GET",
            headers: c.order_invoice_headers,
            credentials: "same-origin",
            "referrer": `https://www.coles.com.au/account/orders/${transaction_obj.orderId}?fromstatus=past`,
            "referrerPolicy": "strict-origin-when-cross-origin"
          };
          req = await Promise.race([
            this.injected_fetch(
              invoice_url,
              options
            ),
            timeout
          ]);
          if (!req) {
            this.console.error("Error in the fetch request - likely a timeout (get_ereceipt, invoice).");
          }
          this.console.debug("invoice fetch result: ", JSON.stringify(req).slice(0, 2e3));
          if (req.status !== 200) {
            this.console.error("Error in the invoice fetch request to coles bff. Status: ", req.status);
            this.console.log("fetch response: ", JSON.stringify(req));
            this.console.log("fetch_object: ", req, req.status);
          }
          const req_text = await req?.text();
          const rx = /\<script\s+id\=\"__NEXT_DATA__\".*?\>(.*?)\<\/script/gm;
          const match = rx.exec(req_text);
          if (match && match[1]) {
            const props = JSON.parse(match[1]);
            if (!props) {
              this.console.error("Invoice parse failed: ", req_text);
            }
            transaction.invoice = props;
          } else {
            this.console.error("Invoice parse failed: __NEXT_DATA__ not found", req_text);
          }
        } catch (e) {
          this.console.error(`Invoice capture is unsuccessful [${this.id}]: `, e);
        }
      }
      return transaction;
    },
    async fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    },
    async page_is_authorised() {
      const c = this.config;
      try {
        const auth_request = await fetch(c.auth_check_url, {
          method: "GET",
          credentials: "include",
          headers: c.auth_check_headers
        });
        const auth_request_json = await auth_request.json();
        if (auth_request?.status !== 200) {
          this.console.error("Error in the fetch request to coles bff (page_is_authorised). Status: ", auth_request.status);
          this.console.log("fetch response: ", JSON.stringify(auth_request_json).slice(0, 2e3));
          return false;
        } else {
          return auth_request_json?.authenticated || false;
        }
      } catch (e) {
        this.console.error("error in page_is_authorised: ", e.message);
        return false;
      }
    },
    download_postprocessor(data) {
      let data_normalised;
      if (typeof data === "object") {
        data = Object.values(data);
      }
      try {
        data_normalised = data.map((d) => {
          let ereceipt_data = d.ereceipt;
          let items = [];
          if (ereceipt_data) {
            try {
              items = Object.values(ereceipt_data.items);
              items = items?.map((d2) => {
                return {
                  item_total: d2.orderItem?.itemTotalPrice || d2.itemTotalPrice,
                  product: d2.name || d2.product?.name,
                  unit: d2.orderItem?.hasOwnProperty("weight") ? "kg" : "ea",
                  quantity: (d2.orderItem?.hasOwnProperty("weight") ? d2.orderItem?.weight : d2.orderItem?.quantity) || d2.quantity,
                  unit_price: d2.orderItem?.unitPrice || d2.itemTotalPrice,
                  sku: d2.id || d2.productId
                };
              });
            } catch (e) {
              this.console.error("error in items parsing (download postprocessor): ", e);
              items = [];
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
            items
          };
        });
      } catch (e) {
        this.console.error("error in download preprocessor: ", e);
        data_normalised = void 0;
      }
      return {
        brand: this.id,
        metabrand: this.id,
        captureTime: (/* @__PURE__ */ new Date()).toISOString(),
        ver: this.ver,
        connector_ver: this.ver,
        customer_id: this.customer_id,
        customer_id_type: "barcode",
        download: data,
        normalised_data: data_normalised
      };
    },
    async get_customer_id() {
      const colData = await this.get_site_variable("colData") || [];
      this.console.debug("colData: ", JSON.stringify(colData), typeof colData);
      try {
        const id = colData.filter((e) => e.event === "customer_summary")?.[0]?.data?.customer?.colesIdBarcode;
        this.console.debug("customer_id: ", id);
        if (id) {
          this.customer_id = id;
        } else {
          this.customer_id = void 0;
        }
        return id;
      } catch (e) {
        this.console.error("error in get_customer_id: ", e.message);
        return void 0;
      }
    },
    async coles_credentials() {
      const next_buildId_cached = this.cache.has("next_buildId") ? this.cache.get("next_buildId") : void 0;
      if (next_buildId_cached) {
        return { next_buildId: next_buildId_cached };
      }
      const next_data = await this.get_site_variable("__NEXT_DATA__");
      let next_buildId = next_data?.buildId;
      if (next_buildId) {
        this.cache.set("next_buildId", next_buildId);
        return { next_buildId };
      }
      const c = this.config;
      if (c.next_buildId) {
        return { next_buildId: c.next_buildId };
      }
      return { next_buildId: this.defaultConnectorConfig?.config?.next_buildId };
    }
  };
}

// src/connectors/kmart/config.js
var config_default3 = {
  name: "Kmart",
  enabled: true,
  short_description: "Kmart",
  ver: "3.3.0",
  id: "kmart",
  description: "Kmart Stores",
  doc: "",
  url_match_pattern: ["*://*.kmart.com.au/*"],
  config: {
    graphql_endpoint: "https://api.kmart.com.au/gateway/graphql",
    online_transactions_graphql_query: '{"operationName":"getOrdersForCustomer","variables":{"startsAfter": ___STARTS_AFTER____, "limit": ___LIMIT___},"query":"query getOrdersForCustomer($startsAfter: String, $limit: Float) {\\n  getOrdersForCustomer(startsAfter: $startsAfter, limit: $limit) {\\n    orders {\\n      displayOrderId\\n      orderTotal\\n      orderStatus\\n      orderDate\\n      orderHash\\n      shippedItems {\\n        trackingNumber\\n        carrier\\n        trackingLink\\n        __typename\\n      }\\n      __typename\\n    }\\n    count\\n    startsAfter\\n    __typename\\n  }\\n}\\n"}',
    online_transactions_node: ["getOrdersForCustomer"],
    instore_transactions_graphql_query: '{"operationName":"getInStoreReceipts","variables":{"input":{"limit":___LIMIT___,"after":___AFTER___,"before":___BEFORE___}},"query":"query getInStoreReceipts($input: PaginationInput!) {\\n  getInStoreReceipts(input: $input) {\\n    pagination {\\n      totalCount\\n      next\\n      prev\\n      __typename\\n    }\\n    items {\\n      receipt {\\n        externalId\\n        issuedAtTimestamp\\n        totalPrice\\n        webUrl\\n        xref\\n        __typename\\n      }\\n      store {\\n        name\\n        storeId\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}',
    instore_transactions_node: ["getInStoreReceipts"],
    instore_limit: 50,
    online_limit: 50,
    online_receipt_query: '{"operationName":"GetOrderForGuestByHash","variables":{"hash":"___HASH___"},"query":"query GetOrderForGuestByHash($hash: String!) {\\n  getOrderByHash(hash: $hash) {\\n    ...GetOrderFragment\\n    __typename\\n  }\\n}\\n\\nfragment GetOrderFragment on OrderTrackingResponse {\\n  displayOrderId\\n  orderStatus\\n  orderStatusForMarketplace\\n  orderDate\\n  countryCode\\n  orderType\\n  orderHash\\n  hdExpress\\n  isOnePassActive\\n  marketplaceShippingCost {\\n    sellerId\\n    sellerName\\n    shippingCost\\n    __typename\\n  }\\n  cncExpress {\\n    isExpressOrder\\n    estimatedCollectionInHours\\n    __typename\\n  }\\n  stsCustomerChoice\\n  authorityToLeave\\n  deliveryInstruction\\n  collectedItems {\\n    collectedItemsIndex\\n    items {\\n      itemNumber\\n      itemPrice\\n      itemName\\n      itemShortDescription\\n      itemQuantity\\n      totalPrice\\n      itemActionDate\\n      isPreOrderActive\\n      preOrderExpectedDelivery\\n      preOrderReleaseDate\\n      __typename\\n    }\\n    __typename\\n  }\\n  readyToCollectItems {\\n    readyToCollectIndex\\n    items {\\n      itemNumber\\n      itemPrice\\n      itemName\\n      itemShortDescription\\n      itemQuantity\\n      totalPrice\\n      itemActionDate\\n      isPreOrderActive\\n      preOrderExpectedDelivery\\n      preOrderReleaseDate\\n      __typename\\n    }\\n    __typename\\n  }\\n  shippedItems {\\n    trackingNumber\\n    carrier\\n    carrierColor\\n    trackingLink\\n    trackingIndex\\n    sellerId\\n    sellerName\\n    isFromTarget\\n    items {\\n      itemNumber\\n      itemPrice\\n      itemName\\n      itemShortDescription\\n      itemQuantity\\n      totalPrice\\n      itemActionDate\\n      isPreOrderActive\\n      preOrderExpectedDelivery\\n      preOrderReleaseDate\\n      __typename\\n    }\\n    __typename\\n  }\\n  outstandingItemsV2 {\\n    outstandingItemsIndex\\n    sellerId\\n    sellerName\\n    isFromTarget\\n    estimatedDeliveryDate\\n    items {\\n      itemNumber\\n      itemPrice\\n      itemName\\n      itemShortDescription\\n      itemQuantity\\n      totalPrice\\n      itemExpectedDate\\n      readyByDate\\n      readyByTime\\n      isPreOrderActive\\n      preOrderExpectedDelivery\\n      preOrderReleaseDate\\n      __typename\\n    }\\n    __typename\\n  }\\n  returnedItems {\\n    allItemsActionedOnSameDay\\n    items {\\n      itemNumber\\n      itemPrice\\n      itemName\\n      itemShortDescription\\n      itemQuantity\\n      totalPrice\\n      itemActionDate\\n      isPreOrderActive\\n      preOrderExpectedDelivery\\n      preOrderReleaseDate\\n      sellerId\\n      sellerName\\n      __typename\\n    }\\n    __typename\\n  }\\n  refundedItems {\\n    allItemsActionedOnSameDay\\n    items {\\n      itemNumber\\n      itemPrice\\n      itemName\\n      itemShortDescription\\n      itemQuantity\\n      totalPrice\\n      itemActionDate\\n      isPreOrderActive\\n      preOrderExpectedDelivery\\n      preOrderReleaseDate\\n      sellerId\\n      sellerName\\n      __typename\\n    }\\n    __typename\\n  }\\n  orderTotal\\n  orderSubTotal\\n  kmartShippingTotal\\n  orderDeliveryFee\\n  shippingAddress {\\n    address1\\n    city\\n    countryCode\\n    firstName\\n    lastName\\n    postalCode\\n    province\\n    __typename\\n  }\\n  collectionLocation {\\n    publicName\\n    locationId\\n    address1\\n    address2\\n    address3\\n    city\\n    state\\n    postcode\\n    timezone\\n    isKhub\\n    __typename\\n  }\\n  __typename\\n}\\n"}',
    online_receipt_node: [],
    instore_receipt_request_url: "https://api.slyp.com.au/v1/loyalty/web-receipts/___ERA_HASH___",
    weburl_transformer_regex: "^https://receipts\\.slyp\\.com\\.au/(.*?)(?:/view)?$",
    instore_receipt_node: "",
    proxy: "https://australia-southeast1-rewards-viewer-dev.cloudfunctions.net/corshandler",
    proxy_secret: ""
  }
};

// src/connectors/kmart/connector.js
function connector_default3() {
  return {
    ...config_default3,
    async get_transactions(filter = {}) {
      const c = this.config;
      const graphql_endpoint = c.graphql_endpoint;
      const instore_receipt_graphql_query = c.instore_transactions_graphql_query;
      const instore_limit = c.instore_limit || 6;
      let start_paginator = "null";
      const end_paginator = "null";
      let instore_transactions = [];
      const access_token = (await this._credentials()).access_token;
      if (!access_token) {
        return false;
      }
      do {
        const body = instore_receipt_graphql_query.replace(/___LIMIT___/g, instore_limit).replace(/___AFTER___/g, start_paginator === "null" ? "null" : '"' + start_paginator + '"').replace(/___BEFORE___/g, end_paginator);
        const response = await fetch(graphql_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "Bearer " + access_token
          },
          body,
          credentials: "include"
        });
        const response_json = await response.json();
        if (response.status !== 200) {
          this.console.error("Error fetching instore transactions", response.statusText);
          return;
        }
        const instore_response = response_json;
        if (instore_response) {
          this.console.debug("instore_response", instore_response);
        }
        instore_transactions = instore_transactions.concat(instore_response?.data?.getInStoreReceipts?.items || []);
        const instore_pagination = instore_response?.data?.getInStoreReceipts?.pagination || {};
        const instore_total_count = instore_response?.data?.getInStoreReceipts?.pagination?.totalCount || 0;
        start_paginator = instore_response?.data?.getInStoreReceipts?.pagination?.next || null;
      } while (start_paginator);
      const online_receipt_graphql_query = c.online_transactions_graphql_query;
      const online_limit = c.online_limit || 6;
      start_paginator = "null";
      let online_transactions = [];
      do {
        const body = online_receipt_graphql_query.replace(/___LIMIT___/g, online_limit).replace(/___STARTS_AFTER____/g, start_paginator === "null" ? "null" : '"' + start_paginator + '"');
        const response = await this.injected_fetch(graphql_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "Bearer " + access_token
          },
          body,
          credentials: "include"
        });
        if (response.status !== 200) {
          this.console.error("Error fetching online transactions", response.statusText);
          return;
        }
        const online_response = await response.json();
        if (online_response) {
          this.console.debug("online_response", online_response);
        }
        online_transactions = online_transactions.concat(online_response?.data?.getOrdersForCustomer?.orders || []);
        start_paginator = online_response?.data?.getOrdersForCustomer?.startsAfter || null;
      } while (start_paginator);
      return [...instore_transactions, ...online_transactions];
    },
    async get_ereceipt(transaction_obj) {
      if (transaction_obj.orderHash) {
        const c = this.config;
        const online_receipt_graphql_query = c.online_receipt_query;
        const graphql_endpoint = c.graphql_endpoint;
        const access_token = (await this._credentials()).access_token;
        if (!access_token) {
          return false;
        }
        const body = online_receipt_graphql_query.replace(/___HASH___/g, transaction_obj.orderHash);
        const response = await this.injected_fetch(graphql_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "Bearer " + access_token
          },
          body,
          credentials: "include"
        });
        if (response.status !== 200) {
          this.console.error("Error fetching online receipt", response.statusText);
          return;
        }
        const receipt = await response.json();
        return receipt;
      } else if (transaction_obj.receipt?.webUrl) {
        const c = this.config;
        const instore_receipt_request_url = c.instore_receipt_request_url;
        const regex = new RegExp(c.weburl_transformer_regex);
        const match = transaction_obj.receipt.webUrl.match(regex);
        const era_hash = match ? match[1] : transaction_obj.receipt.webUrl;
        const request_url = instore_receipt_request_url.replace(/___ERA_HASH___/g, era_hash);
        const response = await this.proxied_fetch(request_url, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          }
          //credentials: "include",
        });
        if (response.status !== 200) {
          this.console.error("Error fetching instore receipt", response.statusText);
          return;
        }
        const receipt = await response.json();
        return receipt;
      } else {
        return {};
      }
      return {};
    },
    async page_is_authorised() {
      const site_variable = await this.get_site_variable("localStorage");
      if (!site_variable) {
        return false;
      }
      const auth_key = Object.keys(site_variable).filter(
        (key) => {
          return key.includes("auth0");
        }
      );
      const auth0object = site_variable[auth_key[0]];
      if (!auth0object) {
        return false;
      }
      const auth0 = JSON.parse(auth0object);
      if (!auth0) {
        return false;
      }
      const expiry = auth0["expiresAt"];
      if (!expiry) {
        return false;
      }
      const now = (/* @__PURE__ */ new Date()).getTime() / 1e3;
      if (expiry < now) {
        return false;
      }
      return true;
    },
    async _credentials() {
      if (this.cache.has("credentials")) {
        const credentials = this.cache.get("credentials");
        const now = (/* @__PURE__ */ new Date()).getTime() / 1e3;
        if (credentials.expiry > now) {
          return credentials;
        } else {
          this.cache.delete("credentials");
        }
      }
      const site_variable = await this.get_site_variable("localStorage");
      this.console.debug("site_variable ", site_variable);
      if (!site_variable) {
        return false;
      }
      const auth_key = Object.keys(site_variable).filter(
        (key) => {
          return key.includes("auth0");
        }
      );
      const auth0object = site_variable[auth_key[0]];
      if (!auth0object) {
        return false;
      }
      const auth0 = JSON.parse(auth0object);
      if (!auth0) {
        return false;
      }
      this.cache.set("credentials", { access_token: auth0.body.accessToken, expiry: auth0.body.expiresAt });
      return auth0?.body;
    },
    async get_customer_id() {
      const site_variable = await this.get_site_variable("localStorage");
      if (!site_variable) {
        return false;
      }
      const auth_key = Object.keys(site_variable).filter(
        (key) => {
          return key.includes("auth0");
        }
      );
      const auth0object = site_variable[auth_key[0]];
      if (!auth0object) {
        return false;
      }
      const auth0 = JSON.parse(auth0object);
      if (!auth0) {
        return false;
      }
      return auth0?.body?.decodedToken?.user?.nickname || "(unknown)";
    }
  };
}

// src/connectors/connectors.js
var connectors_default = [connector_default, connector_default2, connector_default3];

// src/components/urlpattern.js
var R = class {
  type = 3;
  name = "";
  prefix = "";
  value = "";
  suffix = "";
  modifier = 3;
  constructor(t, r, n, o, c, l) {
    this.type = t, this.name = r, this.prefix = n, this.value = o, this.suffix = c, this.modifier = l;
  }
  hasCustomName() {
    return this.name !== "" && typeof this.name != "number";
  }
};
var be = /[$_\p{ID_Start}]/u;
var Pe = /[$_\u200C\u200D\p{ID_Continue}]/u;
var M = ".*";
function Re(e, t) {
  return (t ? /^[\x00-\xFF]*$/ : /^[\x00-\x7F]*$/).test(e);
}
function v(e, t = false) {
  let r = [], n = 0;
  for (; n < e.length; ) {
    let o = e[n], c = function(l) {
      if (!t) throw new TypeError(l);
      r.push({ type: "INVALID_CHAR", index: n, value: e[n++] });
    };
    if (o === "*") {
      r.push({ type: "ASTERISK", index: n, value: e[n++] });
      continue;
    }
    if (o === "+" || o === "?") {
      r.push({ type: "OTHER_MODIFIER", index: n, value: e[n++] });
      continue;
    }
    if (o === "\\") {
      r.push({ type: "ESCAPED_CHAR", index: n++, value: e[n++] });
      continue;
    }
    if (o === "{") {
      r.push({ type: "OPEN", index: n, value: e[n++] });
      continue;
    }
    if (o === "}") {
      r.push({ type: "CLOSE", index: n, value: e[n++] });
      continue;
    }
    if (o === ":") {
      let l = "", s = n + 1;
      for (; s < e.length; ) {
        let i = e.substr(s, 1);
        if (s === n + 1 && be.test(i) || s !== n + 1 && Pe.test(i)) {
          l += e[s++];
          continue;
        }
        break;
      }
      if (!l) {
        c(`Missing parameter name at ${n}`);
        continue;
      }
      r.push({ type: "NAME", index: n, value: l }), n = s;
      continue;
    }
    if (o === "(") {
      let l = 1, s = "", i = n + 1, a = false;
      if (e[i] === "?") {
        c(`Pattern cannot start with "?" at ${i}`);
        continue;
      }
      for (; i < e.length; ) {
        if (!Re(e[i], false)) {
          c(`Invalid character '${e[i]}' at ${i}.`), a = true;
          break;
        }
        if (e[i] === "\\") {
          s += e[i++] + e[i++];
          continue;
        }
        if (e[i] === ")") {
          if (l--, l === 0) {
            i++;
            break;
          }
        } else if (e[i] === "(" && (l++, e[i + 1] !== "?")) {
          c(`Capturing groups are not allowed at ${i}`), a = true;
          break;
        }
        s += e[i++];
      }
      if (a) continue;
      if (l) {
        c(`Unbalanced pattern at ${n}`);
        continue;
      }
      if (!s) {
        c(`Missing pattern at ${n}`);
        continue;
      }
      r.push({ type: "REGEX", index: n, value: s }), n = i;
      continue;
    }
    r.push({ type: "CHAR", index: n, value: e[n++] });
  }
  return r.push({ type: "END", index: n, value: "" }), r;
}
function D(e, t = {}) {
  let r = v(e);
  t.delimiter ??= "/#?", t.prefixes ??= "./";
  let n = `[^${S(t.delimiter)}]+?`, o = [], c = 0, l = 0, s = "", i = /* @__PURE__ */ new Set(), a = (h) => {
    if (l < r.length && r[l].type === h) return r[l++].value;
  }, f = () => a("OTHER_MODIFIER") ?? a("ASTERISK"), d = (h) => {
    let u = a(h);
    if (u !== void 0) return u;
    let { type: p, index: A } = r[l];
    throw new TypeError(`Unexpected ${p} at ${A}, expected ${h}`);
  }, T = () => {
    let h = "", u;
    for (; u = a("CHAR") ?? a("ESCAPED_CHAR"); ) h += u;
    return h;
  }, Se = (h) => h, L = t.encodePart || Se, I = "", U = (h) => {
    I += h;
  }, $ = () => {
    I.length && (o.push(new R(3, "", "", L(I), "", 3)), I = "");
  }, V = (h, u, p, A, Y) => {
    let g = 3;
    switch (Y) {
      case "?":
        g = 1;
        break;
      case "*":
        g = 0;
        break;
      case "+":
        g = 2;
        break;
    }
    if (!u && !p && g === 3) {
      U(h);
      return;
    }
    if ($(), !u && !p) {
      if (!h) return;
      o.push(new R(3, "", "", L(h), "", g));
      return;
    }
    let m;
    p ? p === "*" ? m = M : m = p : m = n;
    let O = 2;
    m === n ? (O = 1, m = "") : m === M && (O = 0, m = "");
    let P;
    if (u ? P = u : p && (P = c++), i.has(P)) throw new TypeError(`Duplicate name '${P}'.`);
    i.add(P), o.push(new R(O, P, L(h), m, L(A), g));
  };
  for (; l < r.length; ) {
    let h = a("CHAR"), u = a("NAME"), p = a("REGEX");
    if (!u && !p && (p = a("ASTERISK")), u || p) {
      let g = h ?? "";
      t.prefixes.indexOf(g) === -1 && (U(g), g = ""), $();
      let m = f();
      V(g, u, p, "", m);
      continue;
    }
    let A = h ?? a("ESCAPED_CHAR");
    if (A) {
      U(A);
      continue;
    }
    if (a("OPEN")) {
      let g = T(), m = a("NAME"), O = a("REGEX");
      !m && !O && (O = a("ASTERISK"));
      let P = T();
      d("CLOSE");
      let xe = f();
      V(g, m, O, P, xe);
      continue;
    }
    $(), d("END");
  }
  return o;
}
function S(e) {
  return e.replace(/([.+*?^${}()[\]|/\\])/g, "\\$1");
}
function X(e) {
  return e && e.ignoreCase ? "ui" : "u";
}
function Z(e, t, r) {
  return F(D(e, r), t, r);
}
function k(e) {
  switch (e) {
    case 0:
      return "*";
    case 1:
      return "?";
    case 2:
      return "+";
    case 3:
      return "";
  }
}
function F(e, t, r = {}) {
  r.delimiter ??= "/#?", r.prefixes ??= "./", r.sensitive ??= false, r.strict ??= false, r.end ??= true, r.start ??= true, r.endsWith = "";
  let n = r.start ? "^" : "";
  for (let s of e) {
    if (s.type === 3) {
      s.modifier === 3 ? n += S(s.value) : n += `(?:${S(s.value)})${k(s.modifier)}`;
      continue;
    }
    t && t.push(s.name);
    let i = `[^${S(r.delimiter)}]+?`, a = s.value;
    if (s.type === 1 ? a = i : s.type === 0 && (a = M), !s.prefix.length && !s.suffix.length) {
      s.modifier === 3 || s.modifier === 1 ? n += `(${a})${k(s.modifier)}` : n += `((?:${a})${k(s.modifier)})`;
      continue;
    }
    if (s.modifier === 3 || s.modifier === 1) {
      n += `(?:${S(s.prefix)}(${a})${S(s.suffix)})`, n += k(s.modifier);
      continue;
    }
    n += `(?:${S(s.prefix)}`, n += `((?:${a})(?:`, n += S(s.suffix), n += S(s.prefix), n += `(?:${a}))*)${S(s.suffix)})`, s.modifier === 0 && (n += "?");
  }
  let o = `[${S(r.endsWith)}]|$`, c = `[${S(r.delimiter)}]`;
  if (r.end) return r.strict || (n += `${c}?`), r.endsWith.length ? n += `(?=${o})` : n += "$", new RegExp(n, X(r));
  r.strict || (n += `(?:${c}(?=${o}))?`);
  let l = false;
  if (e.length) {
    let s = e[e.length - 1];
    s.type === 3 && s.modifier === 3 && (l = r.delimiter.indexOf(s) > -1);
  }
  return l || (n += `(?=${c}|${o})`), new RegExp(n, X(r));
}
var x = { delimiter: "", prefixes: "", sensitive: true, strict: true };
var B = { delimiter: ".", prefixes: "", sensitive: true, strict: true };
var q = { delimiter: "/", prefixes: "/", sensitive: true, strict: true };
function J(e, t) {
  return e.length ? e[0] === "/" ? true : !t || e.length < 2 ? false : (e[0] == "\\" || e[0] == "{") && e[1] == "/" : false;
}
function Q(e, t) {
  return e.startsWith(t) ? e.substring(t.length, e.length) : e;
}
function Ee(e, t) {
  return e.endsWith(t) ? e.substr(0, e.length - t.length) : e;
}
function W(e) {
  return !e || e.length < 2 ? false : e[0] === "[" || (e[0] === "\\" || e[0] === "{") && e[1] === "[";
}
var ee = ["ftp", "file", "http", "https", "ws", "wss"];
function N(e) {
  if (!e) return true;
  for (let t of ee) if (e.test(t)) return true;
  return false;
}
function te(e, t) {
  if (e = Q(e, "#"), t || e === "") return e;
  let r = new URL("https://example.com");
  return r.hash = e, r.hash ? r.hash.substring(1, r.hash.length) : "";
}
function re(e, t) {
  if (e = Q(e, "?"), t || e === "") return e;
  let r = new URL("https://example.com");
  return r.search = e, r.search ? r.search.substring(1, r.search.length) : "";
}
function ne(e, t) {
  return t || e === "" ? e : W(e) ? j(e) : z(e);
}
function se(e, t) {
  if (t || e === "") return e;
  let r = new URL("https://example.com");
  return r.password = e, r.password;
}
function ie(e, t) {
  if (t || e === "") return e;
  let r = new URL("https://example.com");
  return r.username = e, r.username;
}
function ae(e, t, r) {
  if (r || e === "") return e;
  if (t && !ee.includes(t)) return new URL(`${t}:${e}`).pathname;
  let n = e[0] == "/";
  return e = new URL(n ? e : "/-" + e, "https://example.com").pathname, n || (e = e.substring(2, e.length)), e;
}
function oe(e, t, r) {
  return _(t) === e && (e = ""), r || e === "" ? e : K(e);
}
function ce(e, t) {
  return e = Ee(e, ":"), t || e === "" ? e : y(e);
}
function _(e) {
  switch (e) {
    case "ws":
    case "http":
      return "80";
    case "wws":
    case "https":
      return "443";
    case "ftp":
      return "21";
    default:
      return "";
  }
}
function y(e) {
  if (e === "") return e;
  if (/^[-+.A-Za-z0-9]*$/.test(e)) return e.toLowerCase();
  throw new TypeError(`Invalid protocol '${e}'.`);
}
function le(e) {
  if (e === "") return e;
  let t = new URL("https://example.com");
  return t.username = e, t.username;
}
function fe(e) {
  if (e === "") return e;
  let t = new URL("https://example.com");
  return t.password = e, t.password;
}
function z(e) {
  if (e === "") return e;
  if (/[\t\n\r #%/:<>?@[\]^\\|]/g.test(e)) throw new TypeError(`Invalid hostname '${e}'`);
  let t = new URL("https://example.com");
  return t.hostname = e, t.hostname;
}
function j(e) {
  if (e === "") return e;
  if (/[^0-9a-fA-F[\]:]/g.test(e)) throw new TypeError(`Invalid IPv6 hostname '${e}'`);
  return e.toLowerCase();
}
function K(e) {
  if (e === "" || /^[0-9]*$/.test(e) && parseInt(e) <= 65535) return e;
  throw new TypeError(`Invalid port '${e}'.`);
}
function he(e) {
  if (e === "") return e;
  let t = new URL("https://example.com");
  return t.pathname = e[0] !== "/" ? "/-" + e : e, e[0] !== "/" ? t.pathname.substring(2, t.pathname.length) : t.pathname;
}
function ue(e) {
  return e === "" ? e : new URL(`data:${e}`).pathname;
}
function de(e) {
  if (e === "") return e;
  let t = new URL("https://example.com");
  return t.search = e, t.search.substring(1, t.search.length);
}
function pe(e) {
  if (e === "") return e;
  let t = new URL("https://example.com");
  return t.hash = e, t.hash.substring(1, t.hash.length);
}
var H = class {
  #i;
  #n = [];
  #t = {};
  #e = 0;
  #s = 1;
  #l = 0;
  #o = 0;
  #d = 0;
  #p = 0;
  #g = false;
  constructor(t) {
    this.#i = t;
  }
  get result() {
    return this.#t;
  }
  parse() {
    for (this.#n = v(this.#i, true); this.#e < this.#n.length; this.#e += this.#s) {
      if (this.#s = 1, this.#n[this.#e].type === "END") {
        if (this.#o === 0) {
          this.#b(), this.#f() ? this.#r(9, 1) : this.#h() ? this.#r(8, 1) : this.#r(7, 0);
          continue;
        } else if (this.#o === 2) {
          this.#u(5);
          continue;
        }
        this.#r(10, 0);
        break;
      }
      if (this.#d > 0) if (this.#A()) this.#d -= 1;
      else continue;
      if (this.#T()) {
        this.#d += 1;
        continue;
      }
      switch (this.#o) {
        case 0:
          this.#P() && this.#u(1);
          break;
        case 1:
          if (this.#P()) {
            this.#C();
            let t = 7, r = 1;
            this.#E() ? (t = 2, r = 3) : this.#g && (t = 2), this.#r(t, r);
          }
          break;
        case 2:
          this.#S() ? this.#u(3) : (this.#x() || this.#h() || this.#f()) && this.#u(5);
          break;
        case 3:
          this.#O() ? this.#r(4, 1) : this.#S() && this.#r(5, 1);
          break;
        case 4:
          this.#S() && this.#r(5, 1);
          break;
        case 5:
          this.#y() ? this.#p += 1 : this.#w() && (this.#p -= 1), this.#k() && !this.#p ? this.#r(6, 1) : this.#x() ? this.#r(7, 0) : this.#h() ? this.#r(8, 1) : this.#f() && this.#r(9, 1);
          break;
        case 6:
          this.#x() ? this.#r(7, 0) : this.#h() ? this.#r(8, 1) : this.#f() && this.#r(9, 1);
          break;
        case 7:
          this.#h() ? this.#r(8, 1) : this.#f() && this.#r(9, 1);
          break;
        case 8:
          this.#f() && this.#r(9, 1);
          break;
        case 9:
          break;
        case 10:
          break;
      }
    }
    this.#t.hostname !== void 0 && this.#t.port === void 0 && (this.#t.port = "");
  }
  #r(t, r) {
    switch (this.#o) {
      case 0:
        break;
      case 1:
        this.#t.protocol = this.#c();
        break;
      case 2:
        break;
      case 3:
        this.#t.username = this.#c();
        break;
      case 4:
        this.#t.password = this.#c();
        break;
      case 5:
        this.#t.hostname = this.#c();
        break;
      case 6:
        this.#t.port = this.#c();
        break;
      case 7:
        this.#t.pathname = this.#c();
        break;
      case 8:
        this.#t.search = this.#c();
        break;
      case 9:
        this.#t.hash = this.#c();
        break;
      case 10:
        break;
    }
    this.#o !== 0 && t !== 10 && ([1, 2, 3, 4].includes(this.#o) && [6, 7, 8, 9].includes(t) && (this.#t.hostname ??= ""), [1, 2, 3, 4, 5, 6].includes(this.#o) && [8, 9].includes(t) && (this.#t.pathname ??= this.#g ? "/" : ""), [1, 2, 3, 4, 5, 6, 7].includes(this.#o) && t === 9 && (this.#t.search ??= "")), this.#R(t, r);
  }
  #R(t, r) {
    this.#o = t, this.#l = this.#e + r, this.#e += r, this.#s = 0;
  }
  #b() {
    this.#e = this.#l, this.#s = 0;
  }
  #u(t) {
    this.#b(), this.#o = t;
  }
  #m(t) {
    return t < 0 && (t = this.#n.length - t), t < this.#n.length ? this.#n[t] : this.#n[this.#n.length - 1];
  }
  #a(t, r) {
    let n = this.#m(t);
    return n.value === r && (n.type === "CHAR" || n.type === "ESCAPED_CHAR" || n.type === "INVALID_CHAR");
  }
  #P() {
    return this.#a(this.#e, ":");
  }
  #E() {
    return this.#a(this.#e + 1, "/") && this.#a(this.#e + 2, "/");
  }
  #S() {
    return this.#a(this.#e, "@");
  }
  #O() {
    return this.#a(this.#e, ":");
  }
  #k() {
    return this.#a(this.#e, ":");
  }
  #x() {
    return this.#a(this.#e, "/");
  }
  #h() {
    if (this.#a(this.#e, "?")) return true;
    if (this.#n[this.#e].value !== "?") return false;
    let t = this.#m(this.#e - 1);
    return t.type !== "NAME" && t.type !== "REGEX" && t.type !== "CLOSE" && t.type !== "ASTERISK";
  }
  #f() {
    return this.#a(this.#e, "#");
  }
  #T() {
    return this.#n[this.#e].type == "OPEN";
  }
  #A() {
    return this.#n[this.#e].type == "CLOSE";
  }
  #y() {
    return this.#a(this.#e, "[");
  }
  #w() {
    return this.#a(this.#e, "]");
  }
  #c() {
    let t = this.#n[this.#e], r = this.#m(this.#l).index;
    return this.#i.substring(r, t.index);
  }
  #C() {
    let t = {};
    Object.assign(t, x), t.encodePart = y;
    let r = Z(this.#c(), void 0, t);
    this.#g = N(r);
  }
};
var G = ["protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"];
var E = "*";
function ge(e, t) {
  if (typeof e != "string") throw new TypeError("parameter 1 is not of type 'string'.");
  let r = new URL(e, t);
  return { protocol: r.protocol.substring(0, r.protocol.length - 1), username: r.username, password: r.password, hostname: r.hostname, port: r.port, pathname: r.pathname, search: r.search !== "" ? r.search.substring(1, r.search.length) : void 0, hash: r.hash !== "" ? r.hash.substring(1, r.hash.length) : void 0 };
}
function b(e, t) {
  return t ? C(e) : e;
}
function w(e, t, r) {
  let n;
  if (typeof t.baseURL == "string") try {
    n = new URL(t.baseURL), t.protocol === void 0 && (e.protocol = b(n.protocol.substring(0, n.protocol.length - 1), r)), !r && t.protocol === void 0 && t.hostname === void 0 && t.port === void 0 && t.username === void 0 && (e.username = b(n.username, r)), !r && t.protocol === void 0 && t.hostname === void 0 && t.port === void 0 && t.username === void 0 && t.password === void 0 && (e.password = b(n.password, r)), t.protocol === void 0 && t.hostname === void 0 && (e.hostname = b(n.hostname, r)), t.protocol === void 0 && t.hostname === void 0 && t.port === void 0 && (e.port = b(n.port, r)), t.protocol === void 0 && t.hostname === void 0 && t.port === void 0 && t.pathname === void 0 && (e.pathname = b(n.pathname, r)), t.protocol === void 0 && t.hostname === void 0 && t.port === void 0 && t.pathname === void 0 && t.search === void 0 && (e.search = b(n.search.substring(1, n.search.length), r)), t.protocol === void 0 && t.hostname === void 0 && t.port === void 0 && t.pathname === void 0 && t.search === void 0 && t.hash === void 0 && (e.hash = b(n.hash.substring(1, n.hash.length), r));
  } catch {
    throw new TypeError(`invalid baseURL '${t.baseURL}'.`);
  }
  if (typeof t.protocol == "string" && (e.protocol = ce(t.protocol, r)), typeof t.username == "string" && (e.username = ie(t.username, r)), typeof t.password == "string" && (e.password = se(t.password, r)), typeof t.hostname == "string" && (e.hostname = ne(t.hostname, r)), typeof t.port == "string" && (e.port = oe(t.port, e.protocol, r)), typeof t.pathname == "string") {
    if (e.pathname = t.pathname, n && !J(e.pathname, r)) {
      let o = n.pathname.lastIndexOf("/");
      o >= 0 && (e.pathname = b(n.pathname.substring(0, o + 1), r) + e.pathname);
    }
    e.pathname = ae(e.pathname, e.protocol, r);
  }
  return typeof t.search == "string" && (e.search = re(t.search, r)), typeof t.hash == "string" && (e.hash = te(t.hash, r)), e;
}
function C(e) {
  return e.replace(/([+*?:{}()\\])/g, "\\$1");
}
function Oe(e) {
  return e.replace(/([.+*?^${}()[\]|/\\])/g, "\\$1");
}
function ke(e, t) {
  t.delimiter ??= "/#?", t.prefixes ??= "./", t.sensitive ??= false, t.strict ??= false, t.end ??= true, t.start ??= true, t.endsWith = "";
  let r = ".*", n = `[^${Oe(t.delimiter)}]+?`, o = /[$_\u200C\u200D\p{ID_Continue}]/u, c = "";
  for (let l = 0; l < e.length; ++l) {
    let s = e[l];
    if (s.type === 3) {
      if (s.modifier === 3) {
        c += C(s.value);
        continue;
      }
      c += `{${C(s.value)}}${k(s.modifier)}`;
      continue;
    }
    let i = s.hasCustomName(), a = !!s.suffix.length || !!s.prefix.length && (s.prefix.length !== 1 || !t.prefixes.includes(s.prefix)), f = l > 0 ? e[l - 1] : null, d = l < e.length - 1 ? e[l + 1] : null;
    if (!a && i && s.type === 1 && s.modifier === 3 && d && !d.prefix.length && !d.suffix.length) if (d.type === 3) {
      let T = d.value.length > 0 ? d.value[0] : "";
      a = o.test(T);
    } else a = !d.hasCustomName();
    if (!a && !s.prefix.length && f && f.type === 3) {
      let T = f.value[f.value.length - 1];
      a = t.prefixes.includes(T);
    }
    a && (c += "{"), c += C(s.prefix), i && (c += `:${s.name}`), s.type === 2 ? c += `(${s.value})` : s.type === 1 ? i || (c += `(${n})`) : s.type === 0 && (!i && (!f || f.type === 3 || f.modifier !== 3 || a || s.prefix !== "") ? c += "*" : c += `(${r})`), s.type === 1 && i && s.suffix.length && o.test(s.suffix[0]) && (c += "\\"), c += C(s.suffix), a && (c += "}"), s.modifier !== 3 && (c += k(s.modifier));
  }
  return c;
}
var me = class {
  #i;
  #n = {};
  #t = {};
  #e = {};
  #s = {};
  #l = false;
  constructor(t = {}, r, n) {
    try {
      let o;
      if (typeof r == "string" ? o = r : n = r, typeof t == "string") {
        let i = new H(t);
        if (i.parse(), t = i.result, o === void 0 && typeof t.protocol != "string") throw new TypeError("A base URL must be provided for a relative constructor string.");
        t.baseURL = o;
      } else {
        if (!t || typeof t != "object") throw new TypeError("parameter 1 is not of type 'string' and cannot convert to dictionary.");
        if (o) throw new TypeError("parameter 1 is not of type 'string'.");
      }
      typeof n > "u" && (n = { ignoreCase: false });
      let c = { ignoreCase: n.ignoreCase === true }, l = { pathname: E, protocol: E, username: E, password: E, hostname: E, port: E, search: E, hash: E };
      this.#i = w(l, t, true), _(this.#i.protocol) === this.#i.port && (this.#i.port = "");
      let s;
      for (s of G) {
        if (!(s in this.#i)) continue;
        let i = {}, a = this.#i[s];
        switch (this.#t[s] = [], s) {
          case "protocol":
            Object.assign(i, x), i.encodePart = y;
            break;
          case "username":
            Object.assign(i, x), i.encodePart = le;
            break;
          case "password":
            Object.assign(i, x), i.encodePart = fe;
            break;
          case "hostname":
            Object.assign(i, B), W(a) ? i.encodePart = j : i.encodePart = z;
            break;
          case "port":
            Object.assign(i, x), i.encodePart = K;
            break;
          case "pathname":
            N(this.#n.protocol) ? (Object.assign(i, q, c), i.encodePart = he) : (Object.assign(i, x, c), i.encodePart = ue);
            break;
          case "search":
            Object.assign(i, x, c), i.encodePart = de;
            break;
          case "hash":
            Object.assign(i, x, c), i.encodePart = pe;
            break;
        }
        try {
          this.#s[s] = D(a, i), this.#n[s] = F(this.#s[s], this.#t[s], i), this.#e[s] = ke(this.#s[s], i), this.#l = this.#l || this.#s[s].some((f) => f.type === 2);
        } catch {
          throw new TypeError(`invalid ${s} pattern '${this.#i[s]}'.`);
        }
      }
    } catch (o) {
      throw new TypeError(`Failed to construct 'URLPattern': ${o.message}`);
    }
  }
  test(t = {}, r) {
    let n = { pathname: "", protocol: "", username: "", password: "", hostname: "", port: "", search: "", hash: "" };
    if (typeof t != "string" && r) throw new TypeError("parameter 1 is not of type 'string'.");
    if (typeof t > "u") return false;
    try {
      typeof t == "object" ? n = w(n, t, false) : n = w(n, ge(t, r), false);
    } catch {
      return false;
    }
    let o;
    for (o of G) if (!this.#n[o].exec(n[o])) return false;
    return true;
  }
  exec(t = {}, r) {
    let n = { pathname: "", protocol: "", username: "", password: "", hostname: "", port: "", search: "", hash: "" };
    if (typeof t != "string" && r) throw new TypeError("parameter 1 is not of type 'string'.");
    if (typeof t > "u") return;
    try {
      typeof t == "object" ? n = w(n, t, false) : n = w(n, ge(t, r), false);
    } catch {
      return null;
    }
    let o = {};
    r ? o.inputs = [t, r] : o.inputs = [t];
    let c;
    for (c of G) {
      let l = this.#n[c].exec(n[c]);
      if (!l) return null;
      let s = {};
      for (let [i, a] of this.#t[c].entries()) if (typeof a == "string" || typeof a == "number") {
        let f = l[i + 1];
        s[a] = f;
      }
      o[c] = { input: n[c] ?? "", groups: s };
    }
    return o;
  }
  static compareComponent(t, r, n) {
    let o = (i, a) => {
      for (let f of ["type", "modifier", "prefix", "value", "suffix"]) {
        if (i[f] < a[f]) return -1;
        if (i[f] === a[f]) continue;
        return 1;
      }
      return 0;
    }, c = new R(3, "", "", "", "", 3), l = new R(0, "", "", "", "", 3), s = (i, a) => {
      let f = 0;
      for (; f < Math.min(i.length, a.length); ++f) {
        let d = o(i[f], a[f]);
        if (d) return d;
      }
      return i.length === a.length ? 0 : o(i[f] ?? c, a[f] ?? c);
    };
    return !r.#e[t] && !n.#e[t] ? 0 : r.#e[t] && !n.#e[t] ? s(r.#s[t], [l]) : !r.#e[t] && n.#e[t] ? s([l], n.#s[t]) : s(r.#s[t], n.#s[t]);
  }
  get protocol() {
    return this.#e.protocol;
  }
  get username() {
    return this.#e.username;
  }
  get password() {
    return this.#e.password;
  }
  get hostname() {
    return this.#e.hostname;
  }
  get port() {
    return this.#e.port;
  }
  get pathname() {
    return this.#e.pathname;
  }
  get search() {
    return this.#e.search;
  }
  get hash() {
    return this.#e.hash;
  }
  get hasRegExpGroups() {
    return this.#l;
  }
};

// src/msd_module.js
if (!globalThis.URLPattern) globalThis.URLPattern = me;
function return_connector(url) {
  let connector = connectors_default.filter(
    (el) => {
      return el().url_match_pattern?.filter(
        (val) => {
          const url_parser = /(.*)\:\/\/(.*)\/(.*)/g;
          const elements = url_parser.exec(val);
          const protocol = elements[1], hostname = elements[2], pathname = elements[3];
          const pattern = new me({ hostname, protocol, pathname });
          return pattern.test(url);
        }
      ).length > 0;
    }
  )[0];
  if (!connector) {
    console.log("No connector for the page is found. Url: ", JSON.stringify(url));
  }
  return connector;
}
var msd_module_default = {
  config: {},
  _logger: console,
  get logger() {
    if (this._logger === console) {
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
    if (this._connector) return this._connector;
    const app = this;
    const url = window.location.href;
    const connectorConstructor = return_connector(url);
    if (connectorConstructor) {
      this._connector = Object.assign(Object.create(connectorPrototype(app)), connectorConstructor(app));
      if (this._connector.init) {
        this._connector.init();
      }
    }
    return this._connector;
  },
  async load_custom_config(config_object) {
    this.config = { ...this.config, ...config_object };
  },
  get_supported_connectors() {
    return connectors_default.map((connectorFn) => {
      const config = connectorFn();
      const patterns = config.url_match_pattern || [];
      let baseUrl = "";
      if (patterns.length > 0) {
        baseUrl = patterns[0].replace(/^[a-z\*]+:\/\//i, "").replace(/^(\*\.|www\.)/i, "").split("/")[0];
      }
      return {
        id: config.id,
        name: config.name,
        url: baseUrl,
        patterns,
        enabled: config.enabled !== false
        // default to true if not specified
      };
    });
  },
  async load_custom_logger(logger_object) {
    const base_logger = logger_object || console;
    const wrapped_logger = Object.create(base_logger);
    const original_error = base_logger.error || console.error;
    wrapped_logger.error = function(...args) {
      if (original_error) original_error.apply(base_logger, args);
      let message = "Unknown error";
      let error = null;
      for (const arg of args) {
        if (typeof arg === "string" && message === "Unknown error") {
          message = arg;
        } else if (arg instanceof Error) {
          error = arg;
          if (message === "Unknown error") message = arg.message;
        } else if (arg && typeof arg === "object" && !error) {
          error = arg;
        }
      }
      window.dispatchEvent(new CustomEvent("msd-error", {
        detail: { message, error, ts: Date.now() }
      }));
    };
    this.logger = wrapped_logger;
  }
};
export {
  msd_module_default as default
};
