const REFRESH_MS = 5000;
const MARKET_LIST_LIMIT = 18;
const MARKET_REFRESH_MS = 10000;
const ARBITRAGE_REFRESH_MS = 15000;
const editableKeys = [
  "MARKET_SLUG",
  "OUTCOME",
  "BUY_BELOW_PRICE",
  "ORDER_SIZE",
  "POLL_INTERVAL_MS",
  "MAX_POSITION_SIZE",
  "MAX_NOTIONAL_PER_ORDER",
  "MARKET_DATA_MODE",
  "DRY_RUN",
  "RUN_ONCE",
  "ENABLE_GEOBLOCK_CHECK",
];

const elements = {
  lastUpdatedLabel: document.getElementById("lastUpdatedLabel"),
  refreshButton: document.getElementById("refreshButton"),
  ticksMetric: document.getElementById("ticksMetric"),
  dryRunOrdersMetric: document.getElementById("dryRunOrdersMetric"),
  liveOrdersMetric: document.getElementById("liveOrdersMetric"),
  skippedSignalsMetric: document.getElementById("skippedSignalsMetric"),
  statusTags: document.getElementById("statusTags"),
  runtimeDetails: document.getElementById("runtimeDetails"),
  configErrorBox: document.getElementById("configErrorBox"),
  marketHeader: document.getElementById("marketHeader"),
  bestBidValue: document.getElementById("bestBidValue"),
  midpointValue: document.getElementById("midpointValue"),
  bestAskValue: document.getElementById("bestAskValue"),
  marketDetails: document.getElementById("marketDetails"),
  signalBanner: document.getElementById("signalBanner"),
  signalReason: document.getElementById("signalReason"),
  signalDetails: document.getElementById("signalDetails"),
  stateDetails: document.getElementById("stateDetails"),
  ordersTable: document.getElementById("ordersTable"),
  ordersBody: document.getElementById("ordersBody"),
  ordersEmpty: document.getElementById("ordersEmpty"),
  arbitrageStatus: document.getElementById("arbitrageStatus"),
  arbitrageEmpty: document.getElementById("arbitrageEmpty"),
  arbitrageGrid: document.getElementById("arbitrageGrid"),
  configForm: document.getElementById("configForm"),
  saveConfigButton: document.getElementById("saveConfigButton"),
  formStatus: document.getElementById("formStatus"),
  marketSearchForm: document.getElementById("marketSearchForm"),
  marketSearchInput: document.getElementById("marketSearchInput"),
  marketSearchButton: document.getElementById("marketSearchButton"),
  explorerStatus: document.getElementById("explorerStatus"),
  marketsGrid: document.getElementById("marketsGrid"),
  selectedMarketSummary: document.getElementById("selectedMarketSummary"),
  orderForm: document.getElementById("orderForm"),
  placeOrderButton: document.getElementById("placeOrderButton"),
  orderStatus: document.getElementById("orderStatus"),
};

let marketCache = null;
let configDirty = false;
let saveInFlight = false;
let hydratedSignature = "";
let orderDirty = false;
let orderHydratedSignature = "";
let orderInFlight = false;
let latestStatus = null;
let activeMarketQuery = "";
let arbitrageCache = null;

elements.refreshButton.addEventListener("click", () => {
  void Promise.all([refresh(true), refreshArbitrage()]);
});

elements.marketSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  activeMarketQuery = elements.marketSearchInput.value.trim();
  void refreshMarkets();
});

elements.configForm.addEventListener("input", (event) => {
  configDirty = true;
  if (isSelectionField(event.target)) {
    marketCache = null;
    void refresh(true);
  }

  if (!saveInFlight) {
    setFormStatus("Unsaved local changes. Saving writes the editable fields into .env.", "neutral");
  }
});

elements.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveConfig();
});

elements.marketsGrid.addEventListener("click", (event) => {
  const button = event.target instanceof HTMLElement ? event.target.closest("[data-market-slug]") : null;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  const { marketSlug, outcome, question } = button.dataset;
  if (!marketSlug || !outcome) {
    return;
  }

  applySelection({
    marketSlug,
    outcome,
    question: question ?? "",
  });
});

elements.orderForm.addEventListener("input", () => {
  orderDirty = true;
  if (!orderInFlight) {
    setOrderStatus("Manual order will use the current slug and outcome from the strategy form.", "neutral");
  }
});

elements.orderForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void placeOrder();
});

void Promise.all([refresh(true), refreshMarkets(), refreshArbitrage()]);
setInterval(() => {
  void refresh(false);
}, REFRESH_MS);
setInterval(() => {
  void refreshMarkets({ silent: true });
}, MARKET_REFRESH_MS);
setInterval(() => {
  void refreshArbitrage({ silent: true });
}, ARBITRAGE_REFRESH_MS);

async function refresh(includeMarket) {
  elements.refreshButton.disabled = true;

  try {
    const status = await fetchJson("/api/status");
    latestStatus = status;
    renderStatus(status);
    renderConfigForm(status);
    renderOrderForm(status);

    let marketError = null;
    const selection = currentSelection(status);

    if (includeMarket || marketCache || selection.marketSlug) {
      try {
        marketCache = await fetchJson(
          `/api/market?${new URLSearchParams({
            marketSlug: selection.marketSlug,
            outcome: selection.outcome,
          }).toString()}`,
        );
      } catch (error) {
        marketError = error instanceof Error ? error.message : String(error);
      }
    }

    renderMarket(marketCache, status, marketError);
    renderSelectedMarketSummary(marketCache, selection);
    elements.lastUpdatedLabel.textContent = marketError
      ? `Updated ${formatTime(status.now)} · market unavailable`
      : `Updated ${formatTime(status.now)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.lastUpdatedLabel.textContent = `Refresh failed: ${message}`;
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function refreshMarkets(options = {}) {
  const { silent = false } = options;
  const query = activeMarketQuery;

  if (!silent) {
    elements.marketSearchInput.value = activeMarketQuery;
    elements.marketSearchButton.disabled = true;
    setExplorerStatus("Loading active markets from Polymarket.", "neutral");
  }

  try {
    const payload = await fetchJson(
      `/api/markets?${new URLSearchParams({
        limit: String(MARKET_LIST_LIMIT),
        ...(query ? { q: query } : {}),
      }).toString()}`,
    );
    renderMarketExplorer(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setExplorerStatus(message, "danger");
    elements.marketsGrid.innerHTML = "";
  } finally {
    if (!silent) {
      elements.marketSearchButton.disabled = false;
    }
  }
}

async function refreshArbitrage(options = {}) {
  const { silent = false } = options;

  if (!silent) {
    setArbitrageStatus("Scanning standard binary markets for complete-set mispricing.", "neutral");
  }

  try {
    const payload = await fetchJson("/api/arbitrage");
    arbitrageCache = payload;
    renderArbitrage(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setArbitrageStatus(message, "danger");
    elements.arbitrageGrid.innerHTML = "";
    elements.arbitrageEmpty.classList.add("hidden");
  }
}

async function saveConfig() {
  saveInFlight = true;
  elements.saveConfigButton.disabled = true;
  setFormStatus("Saving editable fields to .env ...", "neutral");

  try {
    const payload = { values: gatherConfigFormValues() };
    const response = await postJson("/api/config", payload);
    configDirty = false;
    hydratedSignature = JSON.stringify(response.editableConfig ?? {});
    marketCache = null;
    setFormStatus(response.message ?? "Saved to .env. Restart the bot process to apply changes.", "success");
    await refresh(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setFormStatus(message, "danger");
  } finally {
    saveInFlight = false;
    elements.saveConfigButton.disabled = false;
  }
}

async function placeOrder() {
  const selection = currentSelection(latestStatus);
  if (!selection.marketSlug || !selection.outcome) {
    setOrderStatus("Select a market slug and outcome before placing an order.", "danger");
    return;
  }

  orderInFlight = true;
  elements.placeOrderButton.disabled = true;
  setOrderStatus("Submitting order request ...", "neutral");

  try {
    const payload = gatherOrderFormValues(selection);
    const response = await postJson("/api/order", payload);
    orderDirty = false;
    marketCache = response.marketSnapshot ?? null;
    setOrderStatus(response.message ?? "Order submitted.", response.execution?.mode === "live" ? "success" : "neutral");
    await refresh(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setOrderStatus(message, "danger");
  } finally {
    orderInFlight = false;
    elements.placeOrderButton.disabled = false;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }

  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readErrorResponse(response));
  }

  return response.json();
}

async function readErrorResponse(response) {
  const text = await response.text();
  if (!text) {
    return `Request failed: ${response.status}`;
  }

  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    return text;
  }

  return text;
}

function renderStatus(status) {
  const config = status.config ?? {};
  const state = status.state ?? {};
  const stats = state.stats ?? {};

  elements.ticksMetric.textContent = String(stats.ticks ?? 0);
  elements.dryRunOrdersMetric.textContent = String(stats.dryRunOrders ?? 0);
  elements.liveOrdersMetric.textContent = String(stats.liveOrders ?? 0);
  elements.skippedSignalsMetric.textContent = String(stats.skippedSignals ?? 0);

  elements.statusTags.innerHTML = "";
  addTag(
    elements.statusTags,
    config.dryRun ? "Dry Run" : "Live Mode",
    config.dryRun ? "neutral" : "danger",
  );
  addTag(elements.statusTags, config.marketDataMode ?? "Config Missing", "accent");
  addTag(
    elements.statusTags,
    status.configValid ? "Config OK" : "Config Error",
    status.configValid ? "success" : "danger",
  );
  addTag(
    elements.statusTags,
    state.openOrders?.length ? `${state.openOrders.length} Open Orders` : "No Open Orders",
    state.openOrders?.length ? "accent" : "neutral",
  );

  renderDetailList(elements.runtimeDetails, [
    ["Market Slug", config.marketSlug ?? "--"],
    ["Outcome", config.outcome ?? "--"],
    ["Buy Below", formatMaybeNumber(config.buyBelowPrice)],
    ["Order Size", formatMaybeNumber(config.orderSize)],
    ["Polling Interval", formatMaybeDuration(config.pollIntervalMs)],
    ["Heartbeat", formatMaybeDuration(config.heartbeatIntervalMs)],
    ["Env File", status.envFilePath ?? "--"],
    ["State File", status.stateFile ?? "--"],
    ["Dashboard Port", status.dashboard?.port ?? "--"],
    ["Credentials", formatCredentials(config)],
  ]);

  if (status.configError) {
    elements.configErrorBox.classList.remove("hidden");
    elements.configErrorBox.textContent = status.configError;
  } else {
    elements.configErrorBox.classList.add("hidden");
    elements.configErrorBox.textContent = "";
  }

  renderSignal(state.lastSignal, state.lastSnapshot);
  renderState(status, state);
  renderOrders(state.recentOrders ?? []);
}

function renderConfigForm(status) {
  const editableConfig = status.editableConfig ?? {};
  const signature = JSON.stringify(editableConfig);

  if (configDirty || signature === hydratedSignature) {
    return;
  }

  for (const key of editableKeys) {
    const field = elements.configForm.elements.namedItem(key);
    if (!field) {
      continue;
    }

    const value = editableConfig[key];
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      field.checked = Boolean(value);
      continue;
    }

    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
      field.value = value === null || value === undefined ? "" : String(value);
    }
  }

  hydratedSignature = signature;
  if (!saveInFlight) {
    setFormStatus("Editing these controls updates the local .env file. Restart the bot to apply changes.", "neutral");
  }
}

function renderOrderForm(status) {
  const editableConfig = status.editableConfig ?? {};
  const signature = JSON.stringify({
    orderSize: editableConfig.ORDER_SIZE ?? "",
    dryRun: editableConfig.DRY_RUN ?? true,
  });

  if (orderDirty || signature === orderHydratedSignature) {
    return;
  }

  const sizeField = elements.orderForm.elements.namedItem("size");
  const dryRunField = elements.orderForm.elements.namedItem("dryRun");
  const sideField = elements.orderForm.elements.namedItem("side");

  if (sizeField instanceof HTMLInputElement) {
    sizeField.value = editableConfig.ORDER_SIZE === undefined ? "1" : String(editableConfig.ORDER_SIZE);
  }

  if (dryRunField instanceof HTMLInputElement) {
    dryRunField.checked = Boolean(editableConfig.DRY_RUN ?? true);
  }

  if (sideField instanceof HTMLSelectElement && !sideField.value) {
    sideField.value = "BUY";
  }

  orderHydratedSignature = signature;
  if (!orderInFlight) {
    setOrderStatus("Manual order requests use the slug and outcome currently shown in the strategy form.", "neutral");
  }
}

function gatherConfigFormValues() {
  const values = {};

  for (const key of editableKeys) {
    const field = elements.configForm.elements.namedItem(key);
    if (!field) {
      continue;
    }

    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      values[key] = field.checked;
      continue;
    }

    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
      values[key] = field.value.trim();
    }
  }

  return values;
}

function gatherOrderFormValues(selection) {
  const sideField = elements.orderForm.elements.namedItem("side");
  const sizeField = elements.orderForm.elements.namedItem("size");
  const limitPriceField = elements.orderForm.elements.namedItem("limitPrice");
  const dryRunField = elements.orderForm.elements.namedItem("dryRun");

  const payload = {
    marketSlug: selection.marketSlug,
    outcome: selection.outcome,
    side: sideField instanceof HTMLSelectElement ? sideField.value : "BUY",
    size: sizeField instanceof HTMLInputElement ? Number(sizeField.value) : 0,
    dryRun: dryRunField instanceof HTMLInputElement ? dryRunField.checked : true,
  };

  if (limitPriceField instanceof HTMLInputElement && limitPriceField.value.trim() !== "") {
    payload.limitPrice = Number(limitPriceField.value);
  }

  return payload;
}

function renderMarketExplorer(payload) {
  const markets = payload.markets ?? [];
  setExplorerStatus(
    markets.length
      ? `Showing ${markets.length} active markets${payload.query ? ` for “${payload.query}”` : ""}.`
      : `No active markets matched${payload.query ? ` “${payload.query}”` : ""}.`,
    markets.length ? "success" : "neutral",
  );

  elements.marketsGrid.innerHTML = "";

  for (const market of markets) {
    const card = document.createElement("article");
    card.className = "market-card";

    const outcomes = (market.outcomes ?? [])
      .map(
        (outcome) => `
          <button
            type="button"
            class="outcome-chip"
            data-market-slug="${escapeHtml(market.slug)}"
            data-outcome="${escapeHtml(outcome.name)}"
            data-question="${escapeHtml(market.question)}"
          >
            ${escapeHtml(outcome.name)}
            <span>${escapeHtml(formatMaybeNumber(outcome.impliedPrice, 3))}</span>
          </button>
        `,
      )
      .join("");

    card.innerHTML = `
      <div class="market-card-top">
        <div>
          <p class="market-card-question">${escapeHtml(market.question)}</p>
          <p class="market-card-slug">${escapeHtml(market.slug)}</p>
        </div>
        <div class="market-card-meta">
          <span>${escapeHtml(formatMaybeNumber(market.volume, 0))} vol</span>
          <span>${escapeHtml(formatMaybeNumber(market.liquidity, 0))} liq</span>
        </div>
      </div>
      <div class="outcome-row">${outcomes}</div>
      <div class="market-card-foot">
        <span>${market.negRisk ? "Neg Risk" : "Standard"}</span>
        <span>${escapeHtml(formatDateOnly(market.endDate))}</span>
      </div>
    `;

    elements.marketsGrid.appendChild(card);
  }
}

function renderArbitrage(payload) {
  const opportunities = payload.opportunities ?? [];
  const scanned = payload.candidateMarketCount ?? payload.scannedMarketCount ?? 0;
  setArbitrageStatus(
    opportunities.length
      ? `Scanned ${scanned} standard binary markets. Positive edges shown are estimated before gas.`
      : `Scanned ${scanned} standard binary markets. No positive complete-set edge found.`,
    opportunities.length ? "success" : "neutral",
  );

  elements.arbitrageGrid.innerHTML = "";
  if (!opportunities.length) {
    elements.arbitrageEmpty.classList.remove("hidden");
    return;
  }

  elements.arbitrageEmpty.classList.add("hidden");

  for (const opportunity of opportunities) {
    const card = document.createElement("article");
    card.className = "arbitrage-card";
    card.innerHTML = `
      <div class="arbitrage-head">
        <div>
          <p class="arbitrage-question">${escapeHtml(opportunity.marketQuestion)}</p>
          <p class="arbitrage-subtitle">
            ${escapeHtml(opportunity.marketSlug)} · ${escapeHtml(arbitrageLabel(opportunity.kind))}
          </p>
        </div>
        <div class="arbitrage-edge ${opportunity.estimatedEdgePerSet > 0 ? "positive" : "negative"}">
          ${escapeHtml(formatSignedNumber(opportunity.estimatedEdgePerSet, 4))} / set
        </div>
      </div>
      <dl class="detail-list compact arbitrage-details">
        ${detailRows([
          ["Edge (bps)", formatSignedNumber(opportunity.estimatedEdgeBps, 1)],
          ["Max Sets", formatMaybeNumber(opportunity.maxExecutableSets, 2)],
          [
            opportunity.kind === "buy_complete_set" ? "Gross Cost" : "Net Proceeds",
            formatMaybeNumber(
              opportunity.kind === "buy_complete_set"
                ? opportunity.grossCostPerSet
                : opportunity.netProceedsPerSet,
              4,
            ),
          ],
          ["Yes Ask/Bid", formatLegPrices(opportunity.legs.yes)],
          ["No Ask/Bid", formatLegPrices(opportunity.legs.no)],
          ["Fee Rates", `${formatFeeRate(opportunity.legs.yes.feeRateBps)} / ${formatFeeRate(opportunity.legs.no.feeRateBps)}`],
        ])}
      </dl>
    `;
    elements.arbitrageGrid.appendChild(card);
  }
}

function renderMarket(marketPayload, status, marketError) {
  if (!marketPayload && !marketError) {
    elements.marketHeader.innerHTML =
      "<h3>Market data unavailable</h3><p>No market data loaded yet.</p>";
    elements.bestBidValue.textContent = "--";
    elements.midpointValue.textContent = "--";
    elements.bestAskValue.textContent = "--";
    renderDetailList(elements.marketDetails, []);
    return;
  }

  if (!marketPayload || marketPayload.error) {
    const errorMessage = marketError ?? marketPayload?.error ?? "Unknown error";
    elements.marketHeader.innerHTML = `<h3>Market data unavailable</h3><p>${escapeHtml(errorMessage)}</p>`;
    elements.bestBidValue.textContent = "--";
    elements.midpointValue.textContent = "--";
    elements.bestAskValue.textContent = "--";
    renderDetailList(elements.marketDetails, []);
    return;
  }

  const market = marketPayload.market;
  const outcome = marketPayload.outcome;
  const book = marketPayload.orderbook;

  elements.marketHeader.innerHTML = `
    <h3>${escapeHtml(market.question)}</h3>
    <p>${escapeHtml(market.slug)} · ${escapeHtml(outcome.name)}${marketError ? " · stale cache" : ""}</p>
  `;
  elements.bestBidValue.textContent = formatMaybeNumber(book.bestBid, 3);
  elements.midpointValue.textContent = formatMaybeNumber(book.midpoint, 3);
  elements.bestAskValue.textContent = formatMaybeNumber(book.bestAsk, 3);

  renderDetailList(elements.marketDetails, [
    ["Implied Price", formatMaybeNumber(outcome.impliedPrice, 3)],
    ["Liquidity", formatMaybeNumber(market.liquidity, 2)],
    ["Volume", formatMaybeNumber(market.volume, 2)],
    ["Tick Size", book.tickSize ?? "--"],
    ["Neg Risk", market.negRisk ? "Yes" : "No"],
    ["Snapshot", formatTime(marketPayload.fetchedAt)],
    ["Last Source", status.state?.lastSnapshot?.source ?? "--"],
    ["Token ID", shorten(outcome.tokenId, 12, 10)],
  ]);
}

function renderSelectedMarketSummary(marketPayload, selection) {
  if (marketPayload?.market && marketPayload?.outcome) {
    elements.selectedMarketSummary.innerHTML = `
      <strong>${escapeHtml(marketPayload.market.question)}</strong>
      <span>${escapeHtml(marketPayload.market.slug)} · ${escapeHtml(marketPayload.outcome.name)}</span>
    `;
    return;
  }

  if (selection.marketSlug) {
    elements.selectedMarketSummary.innerHTML = `
      <strong>${escapeHtml(selection.question || "Selected market")}</strong>
      <span>${escapeHtml(selection.marketSlug)} · ${escapeHtml(selection.outcome || "--")}</span>
    `;
    return;
  }

  elements.selectedMarketSummary.textContent =
    "Pick a market from the explorer or fill the slug and outcome manually below.";
}

function renderSignal(lastSignal, lastSnapshot) {
  const action = lastSignal?.action ?? "NONE";
  elements.signalBanner.textContent = action;
  elements.signalBanner.className = `signal-banner ${signalClass(action)}`;
  elements.signalReason.textContent =
    lastSignal?.reason ?? "Waiting for the bot to evaluate a market.";

  renderDetailList(elements.signalDetails, [
    ["Signal Time", formatTime(lastSignal?.updatedAt)],
    ["Price", formatMaybeNumber(lastSignal?.price, 4)],
    ["Size", formatMaybeNumber(lastSignal?.size)],
    ["Token", lastSignal?.tokenId ? shorten(lastSignal.tokenId, 12, 10) : "--"],
    ["Snapshot Source", lastSnapshot?.source ?? "--"],
    ["Last Midpoint", formatMaybeNumber(lastSnapshot?.midpoint, 4)],
  ]);
}

function renderState(status, state) {
  const geoblock = state.geoblock;
  const lastSnapshot = state.lastSnapshot;
  const lastOrderEvent = state.lastOrderEvent;

  renderDetailList(elements.stateDetails, [
    ["Env File", status.envFilePresent ? "Present" : "Missing"],
    ["State File", status.stateFilePresent ? "Present" : "Missing"],
    ["Geoblock", geoblock ? (geoblock.blocked ? "Blocked" : "Allowed") : "--"],
    ["Geoblock Region", geoblock ? `${geoblock.country}-${geoblock.region}` : "--"],
    ["Heartbeat", state.heartbeat?.heartbeatId ? shorten(state.heartbeat.heartbeatId, 8, 6) : "--"],
    ["Open Orders", String(state.openOrders?.length ?? 0)],
    ["Last Order Event", lastOrderEvent ? `${lastOrderEvent.eventType} · ${lastOrderEvent.status}` : "--"],
    ["Current Position", formatMaybeNumber(lastSnapshot?.currentPositionSize)],
    ["Last Snapshot", formatTime(lastSnapshot?.updatedAt)],
  ]);
}

function renderOrders(orders) {
  elements.ordersBody.innerHTML = "";

  if (!orders.length) {
    elements.ordersTable.classList.add("hidden");
    elements.ordersEmpty.classList.remove("hidden");
    return;
  }

  elements.ordersEmpty.classList.add("hidden");
  elements.ordersTable.classList.remove("hidden");

  for (const order of [...orders].reverse()) {
    const eventDetails = orderEventDetails(order);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(formatTime(order.createdAt))}</td>
      <td>${escapeHtml(order.mode)}</td>
      <td>${escapeHtml(order.status ?? "--")}</td>
      <td>${escapeHtml(order.side)}</td>
      <td>${escapeHtml(formatMaybeNumber(order.price, 4))}</td>
      <td>${escapeHtml(formatMaybeNumber(order.size))}</td>
      <td>${escapeHtml(order.orderId ? shorten(order.orderId, 10, 8) : "--")}</td>
      <td>
        <div class="order-event-title">${escapeHtml(eventDetails.title)}</div>
        <div class="order-event-meta">${escapeHtml(eventDetails.meta)}</div>
      </td>
      <td>${escapeHtml(order.reason)}</td>
    `;
    elements.ordersBody.appendChild(row);
  }
}

function orderEventDetails(order) {
  const cachedOutcomeToken = marketCache?.outcome?.tokenId;
  const fallbackTitle =
    !order.marketQuestion && cachedOutcomeToken && cachedOutcomeToken === order.tokenId
      ? marketCache?.market?.question
      : null;
  const fallbackSlug =
    !order.marketSlug && cachedOutcomeToken && cachedOutcomeToken === order.tokenId
      ? marketCache?.market?.slug
      : null;
  const fallbackOutcome =
    !order.outcomeName && cachedOutcomeToken && cachedOutcomeToken === order.tokenId
      ? marketCache?.outcome?.name
      : null;

  const title = order.marketQuestion || fallbackTitle || order.marketSlug || shorten(order.tokenId, 10, 8);
  const meta = [order.outcomeName || fallbackOutcome, order.marketSlug || fallbackSlug]
    .filter(Boolean)
    .join(" · ");

  return {
    title,
    meta: meta || shorten(order.tokenId, 10, 8),
  };
}

function applySelection(selection) {
  setConfigField("MARKET_SLUG", selection.marketSlug);
  setConfigField("OUTCOME", selection.outcome);
  configDirty = true;
  marketCache = null;
  setFormStatus("Selection updated locally. Save to persist it into .env.", "neutral");
  renderSelectedMarketSummary(null, selection);
  void refresh(true);
}

function currentSelection(status) {
  const slugField = elements.configForm.elements.namedItem("MARKET_SLUG");
  const outcomeField = elements.configForm.elements.namedItem("OUTCOME");

  const marketSlug =
    slugField instanceof HTMLInputElement && slugField.value.trim()
      ? slugField.value.trim()
      : status?.editableConfig?.MARKET_SLUG ?? "";
  const outcome =
    outcomeField instanceof HTMLInputElement && outcomeField.value.trim()
      ? outcomeField.value.trim()
      : status?.editableConfig?.OUTCOME ?? "Yes";

  return {
    marketSlug,
    outcome,
    question: marketCache?.market?.question ?? "",
  };
}

function setConfigField(name, value) {
  const field = elements.configForm.elements.namedItem(name);
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
    field.value = value;
  }
}

function isSelectionField(target) {
  return target instanceof HTMLInputElement && (target.name === "MARKET_SLUG" || target.name === "OUTCOME");
}

function renderDetailList(target, entries) {
  target.innerHTML = "";

  for (const [label, value] of entries) {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-row";

    const dt = document.createElement("dt");
    dt.textContent = label;

    const dd = document.createElement("dd");
    dd.textContent = value;

    wrapper.appendChild(dt);
    wrapper.appendChild(dd);
    target.appendChild(wrapper);
  }
}

function addTag(target, label, tone) {
  const tag = document.createElement("span");
  tag.className = `tag ${tone}`;
  tag.textContent = label;
  target.appendChild(tag);
}

function setFormStatus(message, tone) {
  elements.formStatus.textContent = message;
  elements.formStatus.className = `form-status ${tone}`;
}

function setOrderStatus(message, tone) {
  elements.orderStatus.textContent = message;
  elements.orderStatus.className = `form-status ${tone}`;
}

function setExplorerStatus(message, tone) {
  elements.explorerStatus.textContent = message;
  elements.explorerStatus.className = `form-status ${tone}`;
}

function setArbitrageStatus(message, tone) {
  elements.arbitrageStatus.textContent = message;
  elements.arbitrageStatus.className = `form-status ${tone}`;
}

function formatCredentials(config) {
  if (config.hasPrivateKey && config.hasApiKeySet) {
    return "Private key + API creds";
  }
  if (config.hasPrivateKey) {
    return "Private key only";
  }
  if (config.hasApiKeySet) {
    return "API creds only";
  }
  return "None";
}

function formatMaybeNumber(value, fractionDigits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: fractionDigits,
  }).format(Number(value));
}

function formatSignedNumber(value, fractionDigits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }

  const numeric = Number(value);
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${formatMaybeNumber(numeric, fractionDigits)}`;
}

function formatFeeRate(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }

  return `${(Number(value) / 100).toFixed(2)}%`;
}

function formatLegPrices(leg) {
  return `${formatMaybeNumber(leg.ask, 3)} / ${formatMaybeNumber(leg.bid, 3)}`;
}

function arbitrageLabel(kind) {
  return kind === "buy_complete_set" ? "Buy Yes + No, then merge" : "Split, then sell both sides";
}

function detailRows(entries) {
  return entries
    .map(
      ([label, value]) => `
        <div class="detail-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `,
    )
    .join("");
}

function formatMaybeDuration(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }
  return `${Number(value)} ms`;
}

function formatTime(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDateOnly(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
  }).format(date);
}

function shorten(value, head, tail) {
  if (!value) {
    return "--";
  }
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function signalClass(action) {
  switch (action) {
    case "BUY":
      return "buy";
    case "SELL":
      return "sell";
    case "HOLD":
      return "hold";
    default:
      return "neutral";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
