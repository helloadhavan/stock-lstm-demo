import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from yfinance import Ticker
from flask import Flask, jsonify, render_template, request, Response
from torch import nn


# ================= Configuration =================

BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "stock_predictor"

MODEL_PATH = MODEL_DIR / "model.pt"
METADATA_PATH = MODEL_DIR / "metadata.json"

SEQUENCE_LENGTH = 20
FEATURES = ["Open", "High", "Low", "Close", "Volume"]

app = Flask(__name__)

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

print(f"Prediction device: {device}")


# ================= Model ==========================

class Model(nn.Module):
    def __init__(
        self,
        num_tickers,
        numeric_features=5,
        embedding_dim=16,
        output_size=5,
    ):
        super().__init__()

        self.ticker_embedding = nn.Embedding(
            num_embeddings=num_tickers + 1,
            embedding_dim=embedding_dim,
        )

        self.lstm = nn.LSTM(
            input_size=numeric_features + embedding_dim,
            hidden_size=128,
            num_layers=3,
            batch_first=True,
        )

        self.mlp = nn.Sequential(
            nn.Linear(128, 128),
            nn.GELU(),
            nn.Linear(128, 256),
            nn.GELU(),
            nn.Dropout(0.2),
            nn.Linear(256, 128),
            nn.GELU(),
            nn.Linear(128, output_size),
        )

    def forward(self, x):
        numeric = x[..., :5]
        ticker_ids = x[..., 5].long()

        ticker_vectors = self.ticker_embedding(ticker_ids)
        x = torch.cat([numeric, ticker_vectors], dim=-1)

        output, _ = self.lstm(x)

        return self.mlp(output[:, -1, :])


# ================= Load metadata ==================

if not METADATA_PATH.exists():
    raise FileNotFoundError(f"Missing metadata: {METADATA_PATH}")

with METADATA_PATH.open("r", encoding="utf-8") as file:
    metadata = json.load(file)

ticker_ids = {
    str(ticker): int(ticker_id)
    for ticker, ticker_id in metadata["ticker_ids"].items()
}

means = torch.tensor(metadata["mean"], dtype=torch.float32)
stds = torch.tensor(metadata["std"], dtype=torch.float32)

if metadata.get("features") != FEATURES:
    raise ValueError(
        f"Expected features {FEATURES}, "
        f"but metadata contains {metadata.get('features')}"
    )

if means.shape != stds.shape or means.ndim != 2:
    raise ValueError("Invalid mean/std arrays in metadata.")

if means.shape[1] != len(FEATURES):
    raise ValueError("Normalization statistics have the wrong shape.")

if not torch.isfinite(means).all() or not torch.isfinite(stds).all():
    raise ValueError("Normalization statistics contain non-finite values.")

if (stds <= 0).any():
    raise ValueError("Normalization standard deviations must be positive.")

if any(
    ticker_id <= 0 or ticker_id >= len(means)
    for ticker_id in ticker_ids.values()
):
    raise ValueError("A ticker ID is outside the normalization arrays.")

model = Model(
    num_tickers=len(ticker_ids),
    output_size=len(FEATURES),
).to(device)

if not MODEL_PATH.exists():
    raise FileNotFoundError(f"Missing model checkpoint: {MODEL_PATH}")

state_dict = torch.load(
    MODEL_PATH,
    map_location=device,
    weights_only=True,
)

model.load_state_dict(state_dict)
model.eval()

print(f"Loaded model: {MODEL_PATH}")
print(f"Known tickers: {len(ticker_ids)}")

def get_ticker_data(ticker):
    ticker = ticker.strip().upper()

    if not ticker:
        return pd.DataFrame()

    frame = Ticker(ticker).history(
        period="1mo",
        interval="1d",
        auto_adjust=False,
    )

    if frame.empty:
        return frame

    # yfinance returns the date as the index.
    frame = frame.reset_index()

    # Normalize the date column name.
    if "Datetime" in frame.columns:
        frame = frame.rename(columns={"Datetime": "Date"})
    elif "Date" not in frame.columns:
        return pd.DataFrame()

    # Your model expects these exact feature names.
    required = ["Open", "High", "Low", "Close", "Volume"]

    missing = [
        feature for feature in required
        if feature not in frame.columns
    ]

    if missing:
        raise ValueError(f"Missing stock columns: {missing}")

    frame = frame[["Date", *required]].copy()

    frame = frame.replace(
        [float("inf"), float("-inf")],
        float("nan"),
    ).dropna(subset=required)

    return frame


def serialize_dates(frame):
    result = frame.copy()

    result["Date"] = pd.to_datetime(
        result["Date"], errors="coerce", utc=True
    ).map(
        lambda value: value.isoformat()
        if pd.notna(value)
        else None
    )

    return result


def load_tickers():
    ticker_file = (
        "/home/sadhu/PycharmProjects/project/"
        "stock_data2/tickers.jsonl"
    )

    tickers = []

    with open(ticker_file, encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue

            data = json.loads(line)
            ticker = str(data.get("ticker", "")).strip().upper()

            if ticker:
                tickers.append(ticker)

    return sorted(set(tickers))


# ================= Frontend =======================

@app.get("/")
def index():
    return render_template("index.html")


# ================= Ticker API =====================

@app.get("/stocks/tickers")
def get_tickers():
    try:
        return jsonify({"tickers": load_tickers()})
    except (OSError, ValueError, KeyError) as error:
        app.logger.exception("Could not load ticker list")
        return jsonify({"error": str(error)}), 500


# ================= CSV API ========================

@app.get("/stocks/csv/<ticker>")
def get_csv(ticker):
    try:
        frame = get_ticker_data(ticker)

        if frame.empty:
            return jsonify({"error": "No stock data found."}), 404

        output = serialize_dates(frame).to_csv(index=False)

        return Response(
            output,
            mimetype="text/csv",
            headers={
                "Content-Disposition":
                    f'attachment; filename="{ticker.upper()}.csv"'
            },
        )

    except Exception:
        app.logger.exception("Failed to retrieve CSV stock data")
        return jsonify({"error": "Failed to retrieve stock data."}), 502


# ================= JSONL API =====================

@app.get("/stocks/jsonl/<ticker>")
def get_jsonl(ticker):
    try:
        frame = get_ticker_data(ticker)

        if frame.empty:
            return jsonify({"error": "No stock data found."}), 404

        records = serialize_dates(frame).to_dict(orient="records")

        output = "\n".join(
            json.dumps(record, allow_nan=False)
            for record in records
        )

        if output:
            output += "\n"

        return Response(
            output,
            mimetype="application/x-ndjson",
            headers={
                "Content-Disposition":
                    f'attachment; filename="{ticker.upper()}.jsonl"'
            },
        )

    except Exception:
        app.logger.exception("Failed to retrieve JSONL stock data")
        return jsonify({"error": "Failed to retrieve stock data."}), 502


# ================= Model info API =================

@app.get("/model/info")
def model_info():
    return jsonify({
        "loaded": True,
        "device": str(device),
        "sequence_length": SEQUENCE_LENGTH,
        "features": FEATURES,
        "ticker_count": len(ticker_ids),
    })


# ================= Prediction API =================

@app.post("/predict")
def  predict():
    body = request.get_json(silent=True)

    if not isinstance(body, dict):
        return jsonify({
            "error": "Expected a JSON request body."
        }), 400

    ticker = str(body.get("ticker", "")).strip().upper()

    if ticker not in ticker_ids:
        return jsonify({
            "error": f"Ticker {ticker!r} is not supported by this model."
        }), 400

    history = body.get("history")

    if not isinstance(history, list) or len(history) != SEQUENCE_LENGTH:
        return jsonify({
            "error": f"Provide exactly {SEQUENCE_LENGTH} historical rows."
        }), 400

    rows = []

    try:
        for index, row in enumerate(history):
            if not isinstance(row, dict):
                raise ValueError(f"History row {index + 1} must be an object.")

            values = []

            for feature in FEATURES:
                value = float(row[feature])

                if not np.isfinite(value):
                    raise ValueError(
                        f"Invalid {feature} value in row {index + 1}."
                    )

                values.append(value)

            open_, high, low, close, volume = values

            if min(open_, high, low, close) <= 0 or volume < 0:
                raise ValueError(
                    f"Invalid prices or volume in row {index + 1}."
                )

            if not (
                low <= open_ <= high
                and low <= close <= high
            ):
                raise ValueError(
                    f"Inconsistent OHLC values in row {index + 1}."
                )

            rows.append(values)

    except (KeyError, TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400

    ticker_id = ticker_ids[ticker]

    values = np.asarray(rows, dtype=np.float32)
    values[:, 4] = np.log1p(values[:, 4])

    mean = means[ticker_id].cpu().numpy()
    std = stds[ticker_id].cpu().numpy()

    values = (values - mean) / std

    ids = np.full(
        (SEQUENCE_LENGTH, 1),
        ticker_id,
        dtype=np.float32,
    )

    model_input = np.concatenate(
        [values, ids],
        axis=1,
    )

    x = torch.from_numpy(
        model_input.copy()
    ).unsqueeze(0).to(device)

    with torch.inference_mode():
        prediction = model(x)[0].float().cpu().numpy()

    # Return model output to original feature scales.
    prediction = prediction * std + mean

    # Undo log1p for volume.
    prediction[4] = np.expm1(
        np.clip(prediction[4], -50, 80)
    )

    prediction = np.nan_to_num(
        prediction,
        nan=0.0,
        posinf=1e30,
        neginf=0.0,
    )

    prediction[4] = max(0.0, prediction[4])

    result = {
        feature: float(value)
        for feature, value in zip(FEATURES, prediction)
    }

    last_date = history[-1].get("Date")

    return jsonify({
        "ticker": ticker,
        "last_input_date": last_date,
        "prediction": result,
    })


# ================= Run server =====================

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=False,
    )
