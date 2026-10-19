const tickerSelect = document.getElementById("ticker");
const loadButton = document.getElementById("load-button");
const downloadButton = document.getElementById("download-button");
const predictButton = document.getElementById("predict-button");
const dataType = document.getElementById("data-type");

const preview = document.getElementById("preview");
const predictionResult = document.getElementById("prediction-result");

const stockTitle = document.getElementById("stock-title");
const stockSubtitle = document.getElementById("stock-subtitle");
const statusText = document.getElementById("status-text");

const previewTitle = document.getElementById("preview-title");
const previewDescription = document.getElementById("preview-description");
const formatBadge = document.getElementById("format-badge");

const FEATURES = ["Open", "High", "Low", "Close", "Volume"];
const SEQUENCE_LENGTH = 30;

let currentTicker = "";
let stockRows = [];
let stockHeaders = [];
let chartInstance = null;


// ================= Helpers ========================

function setStatus(message) {
    statusText.textContent = message;
}

function showError(container, message) {
    container.replaceChildren();

    const element = document.createElement("div");
    element.className = "error";
    element.textContent = message;

    container.appendChild(element);
}

function destroyChart() {
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
}

function showEmpty(message) {
    preview.replaceChildren();

    const container = document.createElement("div");
    container.className = "empty-state";

    const heading = document.createElement("h3");
    heading.textContent = message;

    container.appendChild(heading);
    preview.appendChild(container);
}

async function fetchResponse(url, options = {}) {
    const response = await fetch(url, options);

    if (!response.ok) {
        let message = `HTTP ${response.status}`;

        try {
            const body = await response.json();
            message = body.error || message;
        } catch {
            // The server did not return JSON.
        }

        throw new Error(message);
    }

    return response;
}


// ================= CSV parsing ===================

function parseCSV(text) {
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
        throw new Error("Malformed CSV: unclosed quoted field.");
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);
        records.push(row);
    }

    const nonEmptyRecords = records.filter((record) =>
        record.some((value) => value.trim() !== "")
    );

    if (!nonEmptyRecords.length) {
        return { headers: [], rows: [] };
    }

    const headers = nonEmptyRecords[0].map((value) => value.trim());

    const rows = nonEmptyRecords.slice(1).map((record) => {
        const item = {};

        headers.forEach((header, index) => {
            item[header] = record[index] ?? "";
        });

        return item;
    });

    return { headers, rows };
}


// ================= Ticker loading =================

async function loadTickers() {
    try {
        const response = await fetchResponse("/stocks/tickers");
        const data = await response.json();

        tickerSelect.replaceChildren();

        for (const ticker of data.tickers) {
            const option = document.createElement("option");
            option.value = ticker;
            option.textContent = ticker;

            tickerSelect.appendChild(option);
        }

        if (data.tickers.length === 0) {
            throw new Error("No supported tickers were found.");
        }

        setStatus("Ready");
        await loadStock();
    } catch (error) {
        setStatus("Connection error");
        showError(preview, error.message);
    }
}


// ================= Historical data =================

async function loadStock() {
    const ticker = tickerSelect.value;

    if (!ticker) {
        return;
    }

    loadButton.disabled = true;
    predictButton.disabled = true;
    downloadButton.disabled = true;

    destroyChart();
    setStatus("Loading data...");

    try {
        const response = await fetchResponse(
            `/stocks/csv/${encodeURIComponent(ticker)}`
        );

        const text = await response.text();
        const parsed = parseCSV(text);

        if (parsed.rows.length === 0) {
            throw new Error("This ticker has no historical records.");
        }

        currentTicker = ticker;
        stockHeaders = parsed.headers;
        stockRows = parsed.rows;

        stockTitle.textContent = `${ticker} Stock Data`;
        stockSubtitle.textContent =
            `${stockRows.length.toLocaleString()} historical records`;

        renderPreview();
        setStatus("Loaded");

        predictButton.disabled =
            stockRows.length < SEQUENCE_LENGTH;
    } catch (error) {
        currentTicker = "";
        stockRows = [];
        stockHeaders = [];

        showError(preview, error.message);
        predictionResult.textContent = "Prediction unavailable.";
        setStatus("Error");
    } finally {
        loadButton.disabled = false;
        downloadButton.disabled = false;
    }
}


// ================= Preview rendering ==============

function renderPreview() {
    destroyChart();

    const format = dataType.value;

    formatBadge.textContent =
        format === "line" ? "LINE GRAPH" : format.toUpperCase();

    previewTitle.textContent =
        format === "line" ? "Closing Price Chart" : "Data Preview";

    previewDescription.textContent =
        `${currentTicker} · ${stockRows.length.toLocaleString()} rows`;

    if (format === "csv") {
        renderTable();
    } else if (format === "jsonl") {
        renderJSONL();
    } else {
        renderChart();
    }
}

function renderTable() {
    preview.replaceChildren();

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrap";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    stockHeaders.forEach((header) => {
        const th = document.createElement("th");
        th.textContent = header;
        headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);

    const tbody = document.createElement("tbody");

    for (const row of stockRows) {
        const tr = document.createElement("tr");

        for (const header of stockHeaders) {
            const td = document.createElement("td");
            td.textContent = row[header] ?? "";
            tr.appendChild(td);
        }

        tbody.appendChild(tr);
    }

    table.append(thead, tbody);
    wrapper.appendChild(table);
    preview.appendChild(wrapper);
}

function renderJSONL() {
    preview.replaceChildren();

    const pre = document.createElement("pre");
    pre.className = "json-preview";

    pre.textContent = stockRows
        .map((row) => JSON.stringify(row))
        .join("\n");

    preview.appendChild(pre);
}

function findColumn(candidates) {
    return stockHeaders.find((header) =>
        candidates.includes(header.trim().toLowerCase())
    );
}

function renderChart() {
    preview.replaceChildren();

    const dateColumn = findColumn([
        "date", "datetime", "timestamp"
    ]);

    const closeColumn = findColumn([
        "close", "adj close", "adj_close", "adjclose"
    ]);

    if (!dateColumn || !closeColumn) {
        showError(
            preview,
            "The data must contain a date column and a closing-price column."
        );
        return;
    }

    const validRows = stockRows.filter((row) =>
        row[dateColumn] &&
        Number.isFinite(Number(row[closeColumn]))
    );

    if (!validRows.length) {
        showEmpty("No valid closing-price values.");
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
                label: `${currentTicker} Close`,
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
                    labels: { color: "#e8edf5" }
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
                    ticks: { color: "#8994a7" },
                    grid: {
                        color: "rgba(137, 148, 167, 0.10)"
                    }
                }
            }
        }
    });
}


// ================= Prediction =====================

async function runPrediction() {
    if (
        !currentTicker ||
        currentTicker !== tickerSelect.value ||
        stockRows.length < SEQUENCE_LENGTH
    ) {
        showError(
            predictionResult,
            "Load a ticker with at least 30 rows first."
        );
        return;
    }

    predictButton.disabled = true;
    setStatus("Predicting...");

    predictionResult.textContent = "Running model inference...";

    try {
        // Send the latest 30 raw observations.
        // Do not normalize or log-transform values in JavaScript.
        const history = stockRows
            .slice(-SEQUENCE_LENGTH)
            .map((row) => {
                const raw = {
                    Date: row.Date
                };

                for (const feature of FEATURES) {
                    raw[feature] = Number(row[feature]);
                }

                return raw;
            });

        const response = await fetchResponse("/predict", {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                ticker: currentTicker,
                history: history
            })
        });

        const result = await response.json();

        renderPrediction(result);
        setStatus("Prediction complete");
    } catch (error) {
        showError(predictionResult, error.message);
        setStatus("Prediction failed");
    } finally {
        predictButton.disabled =
            stockRows.length < SEQUENCE_LENGTH;
    }
}

function renderPrediction(result) {
    predictionResult.replaceChildren();

    const grid = document.createElement("div");
    grid.className = "prediction-grid";

    for (const feature of FEATURES) {
        const card = document.createElement("div");
        card.className = "prediction-value";

        const label = document.createElement("span");
        label.className = "label";
        label.textContent = feature;

        const value = document.createElement("span");
        value.className = "value";

        const number = Number(result.prediction[feature]);

        value.textContent = Number.isFinite(number)
            ? number.toLocaleString("en-US", {
                maximumFractionDigits: 4
            })
            : "Unavailable";

        card.append(label, value);
        grid.appendChild(card);
    }

    const date = document.createElement("p");
    date.className = "prediction-date";
    date.textContent =
        `Last input date: ${result.last_input_date ?? "Unknown"}`;

    predictionResult.append(grid, date);
}


// ================= Downloads ======================

async function downloadStock() {
    const ticker = tickerSelect.value;

    if (!ticker) {
        return;
    }

    downloadButton.disabled = true;

    try {
        const format = dataType.value === "jsonl" ? "jsonl" : "csv";

        const response = await fetchResponse(
            `/stocks/${format}/${encodeURIComponent(ticker)}`
        );

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = url;
        link.download = `${ticker}.${format}`;

        document.body.appendChild(link);
        link.click();
        link.remove();

        URL.revokeObjectURL(url);
        setStatus("Download complete");
    } catch (error) {
        showError(preview, error.message);
        setStatus("Download failed");
    } finally {
        downloadButton.disabled = false;
    }
}


// ================= Event listeners =================

loadButton.addEventListener("click", loadStock);

tickerSelect.addEventListener("change", loadStock);

dataType.addEventListener("change", () => {
    if (stockRows.length) {
        renderPreview();
    }
});

predictButton.addEventListener("click", runPrediction);

downloadButton.addEventListener("click", downloadStock);


// ================= Initialization ==================

loadTickers();