FROM python:3.11-slim

# Install system dependencies (Agregamos libgomp1 aquí)
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# (El resto del archivo se queda igual)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install playwright
RUN playwright install chromium

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
