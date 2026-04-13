FROM python:3.11-slim

# 1. Instalación de dependencias del sistema
# Incluimos libgomp1 para LightGBM y las dependencias de Chromium para el scraping
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 2. Configuración del directorio de trabajo
WORKDIR /app

# 3. Instalación de dependencias de Python
# Copiamos el archivo de requerimientos primero para aprovechar la caché de Docker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Configuración de Playwright
# Instalamos la librería y luego el navegador (sin --with-deps para evitar errores de permisos)
RUN pip install playwright
RUN playwright install chromium

# 5. Copiar el resto del código del backend
COPY . .

# 6. Configuración de red
# Exponemos el puerto 8000 que es el estándar de FastAPI
EXPOSE 8000

# 7. Comando de inicio
# Usamos el puerto dinámico de Railway o el 8000 por defecto
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
