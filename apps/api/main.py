"""
BetIQ — FastAPI Backend
Main entry point
"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

# --- Lifespan (startup / shutdown) ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load ML models
    print("🚀 BetIQ API starting up...")
    # TODO: load model weights here on Phase 1+
    yield
    # Shutdown
    print("🛑 BetIQ API shutting down...")


app = FastAPI(
    title="BetIQ API",
    description="Motor de predicciones deportivas y scraping para BetIQ",
    version="0.1.0",
    lifespan=lifespan,
)

# --- CORS ---
# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Permitimos todo para eliminar el error de la consola
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Health check ---
@app.get("/health", tags=["System"])
async def health():
    return {"status": "ok", "version": "0.1.0", "service": "BetIQ API"}


# --- Routers ---
from routers import nba, bets as bets_router, football, tennis, parlay, analyze

app.include_router(nba.router,         prefix="/api/nba",      tags=["NBA"])
app.include_router(football.router,    prefix="/api/football", tags=["Football"])
app.include_router(tennis.router,      prefix="/api/tennis",   tags=["Tennis"])
app.include_router(bets_router.router, prefix="/api/bets",     tags=["Bets"])
app.include_router(parlay.router,      prefix="/api/parlay",   tags=["Parlay"])
app.include_router(analyze.router,     prefix="/api/analyze",  tags=["Analyze"])

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
