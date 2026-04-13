"""
BetIQ — FastAPI Backend
Main entry point
"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Cargar variables de entorno
load_dotenv()

# --- Lifespan (startup / shutdown) ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load ML models
    print("🚀 BetIQ API starting up...")
    try:
        # Aquí es donde se cargarán los modelos en el futuro
        # Por ahora solo verificamos que las variables críticas existan
        if not os.getenv("SUPABASE_URL"):
            print("⚠️ Advertencia: SUPABASE_URL no detectada")
    except Exception as e:
        print(f"❌ Error durante el startup: {e}")
    yield
    # Shutdown
    print("🛑 BetIQ API shutting down...")

app = FastAPI(
    title="BetIQ API",
    description="Motor de predicciones deportivas y scraping para BetIQ",
    version="0.1.0",
    lifespan=lifespan,
)

# --- CORS (Configuración Ultra-Abierta para evitar bloqueos) ---
# Se coloca aquí arriba para asegurar que responda antes que cualquier error interno
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Health check ---
@app.get("/health", tags=["System"])
async def health():
    return {
        "status": "ok", 
        "version": "0.1.0", 
        "service": "BetIQ API",
        "database_configured": bool(os.getenv("SUPABASE_URL"))
    }

# --- Routers ---
# Importamos dentro de bloques try para evitar que un error en un módulo rompa toda la API
try:
    from routers import nba, bets as bets_router, football, tennis, parlay, analyze
    
    app.include_router(nba.router,         prefix="/api/nba",      tags=["NBA"])
    app.include_router(football.router,    prefix="/api/football", tags=["Football"])
    app.include_router(tennis.router,      prefix="/api/tennis",   tags=["Tennis"])
    app.include_router(bets_router.router, prefix="/api/bets",     tags=["Bets"])
    app.include_router(parlay.router,      prefix="/api/parlay",   tags=["Parlay"])
    app.include_router(analyze.router,     prefix="/api/analyze",  tags=["Analyze"])
    print("✅ Routers cargados exitosamente")
except Exception as e:
    print(f"❌ Error crítico cargando routers: {e}")

if __name__ == "__main__":
    import uvicorn
    # Obtenemos el puerto de Railway o usamos 8000 por defecto
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)