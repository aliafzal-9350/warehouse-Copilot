from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from sqlalchemy.orm import Session
from sqlalchemy import text as sa_text
from app.services.gemini import extract_intent_and_slots, generate_chat_response, normalize_message
from app.services.whisper_ai import transcribe_audio_bytes
from app.services.query_engine import generate_sql_from_question, sanitize_sql, format_query_results
from app.core.database import SessionLocal

router = APIRouter()

_pending_deletes: dict[str, str] = {}


def _get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _extract_query_from_slots(slots: dict) -> str | None:
    return (
        slots.get("query")
        or slots.get("reference_no")
        or slots.get("customer")
        or slots.get("batch_no")
    )


def _store_pending_delete(intent: str, slots: dict, missing: list, session_id: str) -> None:
    if intent == "delete_line" and not missing:
        query = _extract_query_from_slots(slots)
        if query:
            _pending_deletes[session_id] = query


def _status_message(intent: str, slots: dict, missing: list) -> dict:
    query = _extract_query_from_slots(slots) or slots.get("item_code")

    if missing:
        labels = {
            "item_code": "Item Code",
            "quantity": "Quantity",
            "warehouse": "Warehouse",
            "location": "Location",
            "query": "Reference / Search Keyword",
        }
        fields = ", ".join(labels.get(m, m) for m in missing)
        return {"action": "request_info", "status": f"Please provide: {fields}"}

    if intent == "smart_receive":
        return {"action": "smart_receive", "status": "📥 Smart Receive — review the details below and confirm."}
    if intent == "adjust_quantity":
        return {"action": "adjust_quantity", "status": None}
    if intent == "delete_line":
        return {"action": "confirm_delete", "status": f"⚠️ Are you sure you want to delete '{query}'? Type 'yes' to confirm."}
    if intent == "open_record":
        return {"action": "open_record", "status": None}
    if intent == "receive_stock":
        return {"action": "open_receive_form", "status": "Opening Goods Receiving form..."}
    if intent == "check_inventory":
        return {"action": "show_inventory", "status": "Loading inventory data..."}
    if intent == "report":
        return {"action": "show_report", "status": "Generating report..."}
    if intent == "query_data":
        return {"action": "query_data", "status": "��� Analyzing your question…"}

    return {"action": "chat_reply", "status": None}


@router.post("/interpret")
def interpret_message(payload: dict):
    message = payload.get("message", "").strip()
    session_id = payload.get("session_id", "default")

    if not message:
        return {
            "intent": "unknown", "slots": {}, "missing": [],
            "action": "chat_reply", "status": "Please enter a command.",
            "response": "Please enter a command.",
        }

    # ── Handle pending delete confirmation ──
    if session_id in _pending_deletes:
        query = _pending_deletes.pop(session_id)
        if message.lower() in ("yes", "confirm", "haan", "ha", "y"):
            return {
                "intent": "delete_line", "slots": {"query": query}, "missing": [],
                "action": "execute_delete", "status": f"Deleting '{query}'...",
                "response": None, "confirmed": True,
            }
        else:
            return {
                "intent": "delete_line", "slots": {"query": query}, "missing": [],
                "action": "delete_cancelled", "status": "Delete cancelled.",
                "response": "Delete operation cancelled.", "confirmed": False,
            }

    # ── NLP extraction ──
    data = extract_intent_and_slots(message)
    intent = data.get("intent", "unknown")
    slots = data.get("slots", {})
    missing = data.get("missing", [])

    action_data = _status_message(intent, slots, missing)
    _store_pending_delete(intent, slots, missing, session_id)

    # ── Fallback chat for unknown intent ──
    response = None
    if intent == "unknown":
        text_low = message.lower()
        greetings = ("hi", "hello", "hey", "assalam", "salam", "good morning",
                    "good afternoon", "good evening", "greetings", "hola", "namaste")
        help_keywords = ("help", "commands", "kya kar sakte", "how to", "what can",
                        "guide", "instructions", "madad")

        if any(w in text_low for w in greetings):
            response = (
                "Assalam-o-alaikum! Main aapka Warehouse Assistant hoon.\n"
                "Stock receive, edit, delete, search — sab yahan se control karein.\n\n"
                "💡 Quick Receive:\n"
                "• \"receive 50 wrench WH1 customer Ali ref PO-151\"\n\n"
                "📊 Data Questions:\n"
                "• \"Total stock in every warehouse\"\n"
                "• \"List all damaged items\"\n"
                "• \"Who is the top supplier?\""
            )
        elif any(w in text_low for w in help_keywords):
            response = (
                "Aap yeh commands try karein:\n\n"
                "📥 Quick Receive (one-line):\n"
                "• \"receive 50 wrench WH1 A1 customer Ali ref PO-151 batch BATCH-01 status ok\"\n"
                "• \"receive 30 hammer WH2 customer Usman\"\n\n"
                "📥 Form Receive:\n"
                "• \"receive stock\" — opens the receiving form\n\n"
                "✏️ Actions:\n"
                "• \"add 10 qty in POS-123\" — quantity update\n"
                "• \"delete POS-456\" — delete a record\n"
                "• \"search customer Ali\" — find records\n"
                "• \"check inventory\" — view all stock\n\n"
                "📊 Data Questions:\n"
                "• \"Total stock of wrench globally\"\n"
                "• \"Compare stock between WH1 and WH2\"\n"
                "• \"Show items expiring in 30 days\"\n"
                "• \"Who is the top supplier?\"\n"
                "• \"Monthly receiving trend\""
            )
        else:
            response = action_data.get("status")

    return {
        "intent": intent,
        "slots": slots,
        "missing": missing,
        "action": action_data.get("action", "chat_reply"),
        "status": action_data.get("status"),
        "response": response,
    }


# ─────────────────────────────────────────────────────────────────────────────
# /chat/query — executes data questions against the database
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/query")
def query_data(payload: dict, db: Session = Depends(_get_db)):
    question = payload.get("question", "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="No question provided.")

    try:
        raw_sql, chart_type = generate_sql_from_question(question)
        safe_sql = sanitize_sql(raw_sql)
    except ValueError as e:
        return {"answer": str(e), "sql": None, "rows": [], "columns": [], "chart_type": None}

    try:
        result = db.execute(sa_text(safe_sql))
        columns = list(result.keys())
        rows = [dict(zip(columns, row)) for row in result.fetchall()]

        for row in rows:
            for k, v in row.items():
                if hasattr(v, "isoformat"):
                    row[k] = v.isoformat()
                elif isinstance(v, float):
                    row[k] = round(v, 2)
                elif v is None:
                    row[k] = None
                try:
                    from decimal import Decimal
                    if isinstance(v, Decimal):
                        row[k] = float(round(v, 2))
                except ImportError:
                    pass

        answer = format_query_results(question, columns, rows)
        return {
            "answer": answer, "sql": safe_sql,
            "rows": rows, "columns": columns,
            "chart_type": chart_type,
        }

    except Exception as exc:
        return {"answer": f"❌ Query execution error: {exc}", "sql": raw_sql, "rows": [], "columns": [], "chart_type": None}


@router.post("/respond")
def respond_message(payload: dict):
    message = payload.get("message", "")
    reply = generate_chat_response(message)
    return {"reply": reply}


@router.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        audio_bytes = await file.read()
        text = transcribe_audio_bytes(audio_bytes)
        return {"text": text}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))