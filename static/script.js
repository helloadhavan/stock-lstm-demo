

const SEQUENCE_LENGTH = 20;

// --------------------------------------------------
// HTML elements
// --------------------------------------------------

const tickerSelect = document.getElementById("ticker");
const loadButton = document.getElementById("load-button");
const downloadButton = document.getElementById("download-button");
const predictButton = document.getElementById("predict-button");
const dataTypeSelect = document.getElementById("data-type");

const stockTitle = document.getElementById("stock-title");
const stockSubtitle = document.getElementById("stock-subtitle");
const statusText = document.getElementById("status-text");
const previewTitle = document.getElementById("preview-title");
const previewDescription = document.getElementById("preview-description");
const formatBadge = document.getElementById("format-badge");
const preview = document.getElementById("preview");
const predictionResult = document.getElementById("prediction-result");

// Chart container and canvas are added to your HTML.
const chartContainer = document.getElementById("chart-container");
const chartCanvas = document.getElementById("stock-chart");

// --------------------------------------------------
// Application state
// --------------------------------------------------

let currentTicker = "";
let currentHistory = [];
let stockChart = null;
let isLoading = false;

// --------------------------------------------------
// Status messages
// --------------------------------------------------

function setStatus(message) {
    statusText.textContent = message;
}

function showError(container, message) {
    container.replaceChildren();

    const paragraph = document.createElement("p");
    paragraph.className = "empty-message";
    paragraph.textContent = message;

    container.appendChild(paragraph);
}

// --------------------------------------------------
// API helper
// --------------------------------------------------

async function fetchJSON(url, options = {}) {
    const response = await fetch(url, options);

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }

    return data;
}

// --------------------------------------------------
// CSV parser
// Handles quoted values and commas inside quotes.
// --------------------------------------------------

function parseCSVLine(line) {
    const fields = [];
    let field = "";
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (insideQuotes && line[i + 1] === '"') {
                field += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (char === "," && !insideQuotes) {
            fields.push(field);
            field = "";
        } else {
            field += char;
        }
    }

    fields.push(field);
    return fields;
}

function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);

    if (lines.length < 2) {
        return [];
    }

    const headers = parseCSVLine(lines[0]).map(
        header => header.trim()
    );

    return lines.slice(1)
        .filter(line => line.trim())
        .map(line => {
            const values = parseCSVLine(line);
            const row = {};

            headers.forEach((header, index) => {
                row[header] = values[index] ?? "";
            });

            return row;
        });
}

// --------------------------------------------------
// Load available tickers
// --------------------------------------------------

async function loadTickers() {
    setStatus("Loading tickers");

    try {
        const data = await fetchJSON("/stocks/tickers");
        const tickers = data.tickers || [];

        tickerSelect.replaceChildren();

        if (tickers.length === 0) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = "No tickers available";
            tickerSelect.appendChild(option);

            setStatus("No tickers found");
            return;
        }

        for (const ticker of tickers) {
            const option = document.createElement("option");
            option.value = ticker;
            option.textContent = ticker;
            tickerSelect.appendChild(option);
        }

        // Automatically load the first ticker.
        await loadStock(tickers[0]);

        setStatus("Connected");
    } catch (error) {
        console.error(error);
        setStatus("Connection failed");
        showError(preview, error.message);
    }
}

// --------------------------------------------------
// Load historical data for a ticker
// --------------------------------------------------

async function loadStock(ticker) {
    if (!ticker || isLoading) {
        return;
    }

    isLoading = true;
    currentTicker = ticker;

    loadButton.disabled = true;
    predictButton.disabled = true;

    setStatus(`Loading ${ticker}`);

    stockTitle.textContent = ticker;
    stockSubtitle.textContent = "Loading historical data...";

    try {
        const response = await fetch(
            `/stocks/csv/${encodeURIComponent(ticker)}`
        );

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(
                errorData.error || "Failed to load historical data."
            );
        }

        const csvText = await response.text();
        const rows = parseCSV(csvText);

        const requiredColumns = [
            "Date",
            "Open",
            "High",
            "Low",
            "Close",
            "Volume",
        ];

        if (
            rows.length === 0 ||
            !requiredColumns.every(column => column in rows[0])
        ) {
            throw new Error(
                "The CSV must contain Date, Open, High, Low, Close and Volume."
            );
        }

        currentHistory = rows
            .filter(row => {
                const validDate =
                    row.Date && !Number.isNaN(Date.parse(row.Date));

                const validNumbers = [
                    "Open", "High", "Low", "Close", "Volume",
                ].every(key =>
                    row[key] !== "" &&
                    Number.isFinite(Number(row[key]))
                );

                return validDate && validNumbers;
            })
            .map(row => ({
                Date: row.Date,
                Open: Number(row.Open),
                High: Number(row.High),
                Low: Number(row.Low),
                Close: Number(row.Close),
                Volume: Number(row.Volume),
            }))
            .sort((a, b) =>
                a.Date.localeCompare(b.Date)
            );

        if (currentHistory.length === 0) {
            throw new Error("No valid historical rows were returned.");
        }

        stockTitle.textContent = ticker;
        stockSubtitle.textContent =
            `${currentHistory.length} historical trading rows`;

        renderSelectedFormat();

        predictButton.disabled =
            currentHistory.length < SEQUENCE_LENGTH;

        if (currentHistory.length < SEQUENCE_LENGTH) {
            stockSubtitle.textContent =
                `Only ${currentHistory.length} valid rows available; ` +
                `${SEQUENCE_LENGTH} are required for prediction.`;
        }

        setStatus("Data loaded");
    } catch (error) {
        console.error(error);

        currentHistory = [];

        stockSubtitle.textContent = "Could not load historical data.";
        showError(preview, error.message);

        if (chartContainer) {
            chartContainer.hidden = true;
        }

        setStatus("Load failed");
    } finally {
        isLoading = false;
        loadButton.disabled = false;
    }
}

// --------------------------------------------------
// Initialize the OHLC line graph
// --------------------------------------------------

function initializeChart() {
    if (!chartCanvas || typeof Chart === "undefined") {
        console.warn(
            "Chart canvas or Chart.js is missing. " +
            "The table and JSONL previews can still work."
        );
        return;
    }

    stockChart = new Chart(chartCanvas, {
        type: "line",

        data: {
            labels: [],

            datasets: [
                {
                    label: "Open",
                    data: [],
                    borderColor: "#3b82f6",
                    backgroundColor: "#3b82f6",
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                },
                {
                    label: "High",
                    data: [],
                    borderColor: "#16a34a",
                    backgroundColor: "#16a34a",
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                },
                {
                    label: "Low",
                    data: [],
                    borderColor: "#dc2626",
                    backgroundColor: "#dc2626",
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                },
                {
                    label: "Close",
                    data: [],
                    borderColor: "#9333ea",
                    backgroundColor: "#9333ea",
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                },
            ],
        },

        options: {
            responsive: true,
            maintainAspectRatio: false,

            interaction: {
                mode: "index",
                intersect: false,
            },

            plugins: {
                title: {
                    display: true,
                    text: "Historical OHLC Prices",
                },

                legend: {
                    display: true,
                    position: "top",
                },

                tooltip: {
                    callbacks: {
                        label(context) {
                            return (
                                `${context.dataset.label}: $` +
                                Number(context.parsed.y).toFixed(2)
                            );
                        },
                    },
                },
            },

            scales: {
                x: {
                    title: {
                        display: true,
                        text: "Trading date",
                    },
                },

                y: {
                    title: {
                        display: true,
                        text: "Price (USD)",
                    },

                    ticks: {
                        callback(value) {
                            return "$" + value;
                        },
                    },
                },
            },
        },
    });
}

// --------------------------------------------------
// Update the four-line graph
// --------------------------------------------------

function updateChart(rows) {
    if (!stockChart) {
        return;
    }

    stockChart.data.labels = rows.map(
        row => String(row.Date).slice(0, 10)
    );

    const features = ["Open", "High", "Low", "Close"];

    features.forEach((feature, index) => {
        stockChart.data.datasets[index].data = rows.map(
            row => row[feature]
        );
    });

    stockChart.options.plugins.title.text =
        `${currentTicker} — Historical OHLC Prices`;

    stockChart.update();
}

// --------------------------------------------------
// CSV table preview
// --------------------------------------------------

function renderTable(rows) {
    preview.replaceChildren();

    if (rows.length === 0) {
        showError(preview, "No data available.");
        return;
    }

    const table = document.createElement("table");
    table.className = "data-table";

    const columns = [
        "Date", "Open", "High", "Low", "Close", "Volume",
    ];

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    for (const column of columns) {
        const th = document.createElement("th");
        th.textContent = column;
        headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    // Display newest rows first in the table.
    for (const row of [...rows].reverse()) {
        const tr = document.createElement("tr");

        for (const column of columns) {
            const td = document.createElement("td");

            if (column === "Date") {
                td.textContent = String(row.Date).slice(0, 10);
            } else if (column === "Volume") {
                td.textContent = Number(row[column]).toLocaleString();
            } else {
                td.textContent = Number(row[column]).toFixed(2);
            }

            tr.appendChild(td);
        }

        tbody.appendChild(tr);
    }

    table.appendChild(tbody);

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    wrapper.appendChild(table);

    preview.appendChild(wrapper);
}

// --------------------------------------------------
// JSONL preview
// --------------------------------------------------

function renderJSONL(rows) {
    preview.replaceChildren();

    const pre = document.createElement("pre");
    pre.className = "jsonl-preview";

    // Limit displayed text to avoid rendering huge previews.
    pre.textContent = rows
        .slice(-100)
        .map(row => JSON.stringify(row))
        .join("\n");

    preview.appendChild(pre);
}

// --------------------------------------------------
// Show whichever format the user selected
// --------------------------------------------------

function renderSelectedFormat() {
    if (currentHistory.length === 0) {
        return;
    }

    const format = dataTypeSelect.value;

    preview.hidden = format === "line";

    if (chartContainer) {
        chartContainer.hidden = format !== "line";
    }

    formatBadge.textContent = format.toUpperCase();

    if (format === "line") {
        previewTitle.textContent = "OHLC Line Graph";
        previewDescription.textContent =
            "Open, High, Low and Close across trading dates.";

        updateChart(currentHistory);
    } else if (format === "jsonl") {
        previewTitle.textContent = "JSONL Preview";
        previewDescription.textContent =
            "One JSON record per historical trading row.";

        renderJSONL(currentHistory);
    } else {
        previewTitle.textContent = "Data Preview";
        previewDescription.textContent =
            "Historical OHLCV records.";

        renderTable(currentHistory);
    }
}

// --------------------------------------------------
// Download historical CSV
// --------------------------------------------------

function downloadCSV() {
    if (!currentTicker) {
        alert("Select a ticker first.");
        return;
    }

    window.location.href =
        `/stocks/csv/${encodeURIComponent(currentTicker)}`;
}

// --------------------------------------------------
// Prediction
// --------------------------------------------------

async function runPrediction() {
    if (currentHistory.length < SEQUENCE_LENGTH) {
        alert(
            `Please load at least ${SEQUENCE_LENGTH} historical rows.`
        );
        return;
    }

    predictButton.disabled = true;
    predictButton.textContent = "Predicting...";

    try {
        // Send the most recent 30 rows in chronological order.
        const history = currentHistory.slice(-SEQUENCE_LENGTH);

        const result = await fetchJSON("/predict", {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
            },

            body: JSON.stringify({
                ticker: currentTicker,
                history: history,
            }),
        });

        displayPrediction(result);
    } catch (error) {
        console.error(error);
        showError(predictionResult, error.message);
    } finally {
        predictButton.disabled =
            currentHistory.length < SEQUENCE_LENGTH;

        predictButton.textContent = "Run Prediction";
    }
}

// --------------------------------------------------
// Display prediction response
// --------------------------------------------------

function displayPrediction(result) {
    predictionResult.replaceChildren();

    // Support responses with either:
    // { prediction: { Open: ..., Close: ... } }
    // or { Open: ..., Close: ... }
    const values =
        result.prediction ??
        result.predictions ??
        result;

    // Handle a prediction returned as an array of values.
    let prediction = values;

    if (Array.isArray(values)) {
        prediction = {
            Open: values[0],
            High: values[1],
            Low: values[2],
            Close: values[3],
            Volume: values[4],
        };
    }

    // Also support a nested list containing one prediction.
    if (Array.isArray(prediction) && prediction.length === 1) {
        prediction = prediction[0];
    }

    const aliases = {
        Open: ["Open", "open", "predicted_open"],
        High: ["High", "high", "predicted_high"],
        Low: ["Low", "low", "predicted_low"],
        Close: ["Close", "close", "predicted_close"],
        Volume: ["Volume", "volume", "predicted_volume"],
    };

    const grid = document.createElement("div");
    grid.className = "prediction-grid";

    let displayed = 0;

    for (const [feature, names] of Object.entries(aliases)) {
        const key = names.find(name =>
            prediction &&
            prediction[name] !== undefined &&
            prediction[name] !== null
        );

        if (!key) {
            continue;
        }

        const value = Number(prediction[key]);

        if (!Number.isFinite(value)) {
            continue;
        }

        const card = document.createElement("div");
        card.className = "prediction-value";

        const label = document.createElement("p");
        label.className = "muted";
        label.textContent = feature;

        const number = document.createElement("h3");
        number.textContent = feature === "Volume"
            ? value.toLocaleString(undefined, {
                maximumFractionDigits: 2,
            })
            : "$" + value.toFixed(4);

        card.append(label, number);
        grid.appendChild(card);

        displayed++;
    }

    if (displayed === 0) {
        const message = document.createElement("p");
        message.className = "empty-message";
        message.textContent =
            "Prediction received, but the response format was not recognized.";

        const details = document.createElement("pre");
        details.textContent = JSON.stringify(result, null, 2);

        predictionResult.append(message, details);
        return;
    }

    predictionResult.appendChild(grid);

    const date = result.last_input_date ?? result.last_date;

    if (date) {
        const dateText = document.createElement("p");
        dateText.className = "muted";
        dateText.textContent = `Last input date: ${date}`;

        predictionResult.appendChild(dateText);
    }

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent =
        "These are model predictions for the next observation.";

    predictionResult.appendChild(note);
}

// --------------------------------------------------
// Event listeners
// --------------------------------------------------

loadButton.addEventListener("click", () => {
    loadStock(tickerSelect.value);
});

tickerSelect.addEventListener("change", () => {
    loadStock(tickerSelect.value);
});

downloadButton.addEventListener("click", downloadCSV);

predictButton.addEventListener("click", runPrediction);

dataTypeSelect.addEventListener("change", renderSelectedFormat);

// --------------------------------------------------
// Start application
// --------------------------------------------------

if (chartCanvas && typeof Chart !== "undefined") {
    initializeChart();
}

loadTickers();
