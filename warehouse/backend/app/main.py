from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import chat, receiving, inventory

from app.core.config import settings
print("DB_URL:", settings.DB_URL)
app = FastAPI(title="Warehouse Copilot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router, prefix="/chat", tags=["Chat"])
app.include_router(receiving.router, prefix="/receiving", tags=["Receiving"])
app.include_router(inventory.router, prefix="/api", tags=["Inventory"])

@app.get("/")
def root():
    return {"status": "ok"}