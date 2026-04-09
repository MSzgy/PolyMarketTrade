const REFRESH_MS = 5000;
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
  configForm: document.getElementById("configForm"),
  saveConfigButton: document.getElementById("saveConfigButton"),
  formStatus: document.getElementById("formStatus"),
};

let marketCache = null;
let configDirty = false;
let saveInFlight = false;
let hydratedSignature = "";

elements.refreshButton.addEventListener("click", () => {
  void refresh(true);
});

elements.configForm.addEventListener("input", () => {
  configDirty = true;
  if (!saveInFlight) {
    setFormStatus("Unsaved local changes. Saving writes the editable fields into .env.", "neutral");
  }
});

elements.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveConfig();
});

void refresh(true);
setInterval(() => {
  void refresh(false);
}, REFRESH_MS);

async function refresh(includeMarket) {
  elements.refreshButton.disabled = true;

  try {
    const status = await fetchJson("/api/status");
    renderStatus(status);
    renderConfigForm(status);

    let marketError = null;
    if (includeMarket || marketCache || status.configValid) {
      try {
        marketCache = await fetchJson("/api/market");
      } catch (error) {
        marketError = error instanceof Error ? error.message : String(error);
      }
    }

    renderMarket(marketCache, status, marketError);
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || `Request failed: ${response.status}`);
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
    const body = await response.text();
    throw new Error(body || `Request failed: ${response.status}`);
  }

  return response.json();
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
    status.stateFilePresent ? "State File Present" : "No State File",
    status.stateFilePresent ? "success" : "neutral",
  );

  renderDetailList(elements.runtimeDetails, [
    ["Market Slug", config.marketSlug ?? "--"],
    ["Outcome", config.outcome ?? "--"],
    ["Buy Below", formatMaybeNumber(config.buyBelowPrice)],
    ["Order Size", formatMaybeNumber(config.orderSize)],
    ["Polling Interval", formatMaybeDuration(config.pollIntervalMs)],
    ["Env File", status.envFilePath ?? "--"],
    ["State File", status.stateFile ?? "--"],
    ["Dashboard Port", status.dashboard?.port ?? "--"],
    ["WebSocket Timeout", formatMaybeDuration(config.marketWsReadyTimeoutMs)],
    ["Geoblock Check", config.enableGeoblockCheck ? "Enabled" : "Disabled"],
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

  renderDetailList(elements.stateDetails, [
    ["Env File", status.envFilePresent ? "Present" : "Missing"],
    ["Env Path", status.envFilePath ?? "--"],
    ["State File", status.stateFilePresent ? "Present" : "Missing"],
    ["Geoblock Country", geoblock?.country ?? "--"],
    ["Geoblock Region", geoblock?.region ?? "--"],
    ["Geoblock Status", geoblock ? (geoblock.blocked ? "Blocked" : "Allowed") : "--"],
    ["Checked At", formatTime(geoblock?.checkedAt)],
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
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(formatTime(order.createdAt))}</td>
      <td>${escapeHtml(order.mode)}</td>
      <td>${escapeHtml(order.side)}</td>
      <td>${escapeHtml(formatMaybeNumber(order.price, 4))}</td>
      <td>${escapeHtml(formatMaybeNumber(order.size))}</td>
      <td>${escapeHtml(shorten(order.tokenId, 10, 8))}</td>
      <td>${escapeHtml(order.reason)}</td>
    `;
    elements.ordersBody.appendChild(row);
  }
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
