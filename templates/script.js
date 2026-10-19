const stockForm = document.getElementById("stock-form");
const tickerInput = document.getElementById("ticker");
const dataType = document.getElementById("data-type");
const preview = document.getElementById("preview");

const stockTitle = document.getElementById("stock-title");
const stockSubtitle = document.getElementById("stock-subtitle");
const previewTitle = document.getElementById("preview-title");
const previewDescription = document.getElementById("preview-description");
const formatBadge = document.getElementById("format-badge");
const statusText = document.getElementById("status-text");

const loadButton = document.getElementById("load-button");
const downloadButton = document.getElementById("download-button");

let stockRows = [];
let stockHeaders = [];
let loadedTicker = "";
let loadedFormat = "";
let chartInstance = null;

const CSV_URL = (ticker) =>
    `/stocks/csv/${encodeURIComponent(ticker)}`;

const JSONL_URL = (ticker) =>
    `/stocks/jsonl/${encodeURIComponent(ticker)}`;

function setStatus(message) {
    statusText.textContent = message;
}

function showError(message) {
    destroyChart();

    preview.replaceChildren();

    const error = document.createElement("div");
    error.className = "error";
    error.textContent = message;

    preview.appendChild(error);
    setStatus("Error");
}

function destroyChart() {
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
}

function getTicker() {
    return tickerInput.value.trim().toUpperCase();
}

function parseCSV(text) {
    // Supports quoted fields, commas inside quotes, and escaped quotes.
    const records = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (quoted) {
            if (char === '"' && text[i + 1] === '"') {
                field += '"';
                i++;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
        } else if (char === '"' && field.length === 0) {
            quoted = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n") {
            row.push(field);
            records.push(row);
            row = [];
            field = "";
        } else if (char !== "\r") {
            field += char;
        }
    }

    if (quoted) {
        throw new Error("The CSV contains an unclosed quoted field.");
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);
        records.push(row);
    }

    return records.filter((record) =>
        record.some((value) => value.trim() !== "")
    );
}

async function fetchStock(format, ticker) {
    const url = format === "jsonl"
        ? JSONL_URL(ticker)
        : CSV_URL(ticker);

    const response = await fetch(url, {
        headers: {
            Accept: format === "jsonl"
                ? "application/x-ndjson, application/json, text/plain"
                : "text/csv, text/plain"
        }
    });

    if (!response.ok) {
        throw new Error(
            `Request failed: ${response.status} ${response.statusText}`
        );
    }

    return response.text();
}

function normalizeRecords(records) {
    if (!records.length) {
        return { headers: [], rows: [] };
    }

    const headers = records[0].map((header) => header.trim());

    const rows = records.slice(1).map((record) => {
        const result = {};

        headers.forEach((header, index) => {
            result[header] = record[index] ?? "";
        });

        return result;
    });

    return { headers, rows };
}

function renderTable(headers, rows) {
    destroyChart();
    preview.replaceChildren();

    if (!headers.length || !rows.length) {
        renderEmpty("No stock records found.");
        return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrap";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    headers.forEach((header) => {
        const th = document.createElement("th");
        th.textContent = header;
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);

    const tbody = document.createElement("tbody");

    rows.forEach((row) => {
        const tr = document.createElement("tr");

        headers.forEach((header) => {
            const td = document.createElement("td");
            td.textContent = row[header] ?? "";
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    wrapper.appendChild(table);
    preview.appendChild(wrapper);
}

function renderJSONL(rows) {
    destroyChart();
    preview.replaceChildren();

    const pre = document.createElement("pre");
    pre.className = "json-preview";

    pre.textContent = rows
        .map((row) => JSON.stringify(row))
        .join("\n");

    preview.appendChild(pre);
}

function renderEmpty(message) {
    preview.replaceChildren();

    const container = document.createElement("div");
    container.className = "empty-state";

    const heading = document.createElement("h3");
    heading.textContent = message;

    container.appendChild(heading);
    preview.appendChild(container);
}

function findColumn(headers, candidates) {
    return headers.find((header) =>
        candidates.includes(header.trim().toLowerCase())
    );
}

function renderChart(headers, rows) {
    destroyChart();
    preview.replaceChildren();

    const dateColumn = findColumn(headers, [
        "date", "datetime", "timestamp", "time"
    ]);

    const closeColumn = findColumn(headers, [
        "close", "adj close", "adj_close", "adjclose"
    ]);

    if (!dateColumn || !closeColumn) {
        showError(
            "Cannot plot the line graph. The CSV must contain a date " +
            "column and a close (or adjusted close) column."
        );
        return;
    }

    const validRows = rows.filter((row) =>
        row[dateColumn] !== "" &&
        Number.isFinite(Number(row[closeColumn]))
    );

    if (!validRows.length) {
        renderEmpty("No valid closing-price data to plot.");
        return;
    }

    const container = document.createElement("div");
    container.className = "chart-container";

    const canvas = document.createElement("canvas");
    container.appendChild(canvas);
    preview.appendChild(container);

    chartInstance = new Chart(canvas, {
        type: "line",

        data: {
            labels: validRows.map((row) => row[dateColumn]),

            datasets: [{
                label: `${loadedTicker} Closing Price`,
                data: validRows.map((row) => Number(row[closeColumn])),
                borderColor: "#8b9cff",
                backgroundColor: "rgba(139, 156, 255, 0.12)",
                borderWidth: 2,
                pointRadius: validRows.length > 100 ? 0 : 2,
                pointHoverRadius: 5,
                fill: true,
                tension: 0.15
            }]
        },

        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: "index"
            },
            plugins: {
                legend: {
                    labels: {
                        color: "#e8edf5"
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: "#8994a7",
                        maxTicksLimit: 10
                    },
                    grid: {
                        color: "rgba(137, 148, 167, 0.10)"
                    }
                },
                y: {
                    ticks: {
                        color: "#8994a7"
                    },
                    grid: {
                        color: "rgba(137, 148, 167, 0.10)"
                    }
                }
            }
        }
    });
}

function renderCurrentFormat() {
    const format = dataType.value;

    formatBadge.textContent =
        format === "line" ? "LINE GRAPH" : format.toUpperCase();

    previewTitle.textContent =
        format === "line" ? "Closing Price Chart" : "Data Preview";

    previewDescription.textContent =
        `${loadedTicker} · ${stockRows.length} records`;

    if (format === "line") {
        renderChart(stockHeaders, stockRows);
    } else if (format === "jsonl") {
        renderJSONL(stockRows);
    } else {
        renderTable(stockHeaders, stockRows);
    }
}

async function loadStock() {
    const ticker = getTicker();

    if (!ticker) {
        showError("Please enter a stock ticker.");
        return;
    }

    if (!/^[A-Z0-9.^_-]+$/.test(ticker)) {
        showError("Please enter a valid ticker symbol.");
        return;
    }

    destroyChart();

    loadButton.disabled = true;
    downloadButton.disabled = true;
    setStatus("Loading...");

    stockTitle.textContent = `${ticker} Stock Data`;
    stockSubtitle.textContent = "Fetching historical stock records...";

    try {
        // Always load CSV because it provides the table and chart data.
        const csvText = await fetchStock("csv", ticker);
        const records = parseCSV(csvText);
        const parsed = normalizeRecords(records);

        loadedTicker = ticker;
        stockHeaders = parsed.headers;
        stockRows = parsed.rows;

        if (!stockHeaders.length) {
            throw new Error("The server returned an empty CSV file.");
        }

        stockSubtitle.textContent = "Historical market data";
        renderCurrentFormat();
        setStatus("Loaded");
    } catch (error) {
        showError(error.message || "Failed to load stock data.");
    } finally {
        loadButton.disabled = false;
        downloadButton.disabled = false;
    }
}

async function downloadStock() {
    const ticker = getTicker();

    if (!ticker) {
        showError("Please enter a stock ticker.");
        return;
    }

    const selectedFormat = dataType.value;
    const format = selectedFormat === "jsonl" ? "jsonl" : "csv";

    downloadButton.disabled = true;
    setStatus("Downloading...");

    try {
        const text = await fetchStock(format, ticker);

        const blob = new Blob([text], {
            type: format === "jsonl"
                ? "application/x-ndjson"
                : "text/csv"
        });

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");

        link.href = url;
        link.download = `${ticker}.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();

        URL.revokeObjectURL(url);
        setStatus("Downloaded");
    } catch (error) {
        showError(error.message || "Download failed.");
    } finally {
        downloadButton.disabled = false;
    }
}

stockForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await loadStock();
});

dataType.addEventListener("change", async () => {
    if (!loadedTicker || loadedTicker !== getTicker()) {
        await loadStock();
        return;
    }

    renderCurrentFormat();
});

downloadButton.addEventListener("click", downloadStock);

// Load the default ticker when the page opens.
loadStock();