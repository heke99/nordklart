FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py ./

CMD ["sh", "-c", "uvicorn worker:app --host 0.0.0.0 --port ${PORT:-8080}"]
