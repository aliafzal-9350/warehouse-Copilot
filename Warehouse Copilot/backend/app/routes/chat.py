from fastapi import APIRouter, UploadFile, File, HTTPException
from app.services.gemini import extract_intent_and_slots, generate_chat_response, normalize_message
from app.services.whisper_ai import transcribe_audio_bytes

router = APIRouter()

# ── In-memory pending delete confirmations (use Redis in production) ──
_pending_deletes: dict[str, str] = {}


def _extract_query_from_slots(slots: dict) -> str | None:
    """Extract query from slots, checking multiple possible fields."""
    return (
        slots.get("query")
        or slots.get("reference_no")
        or slots.get("customer")
        or slots.get("batch_no")
    )


def _store_pending_delete(intent: str, slots: dict, missing: list, session_id: str) -> None:
    """Store pending delete confirmation if applicable."""
    if intent == "delete_line" and not missing:
        query = _extract_query_from_slots(slots)
        if query:
            _pending_deletes[session_id] = query


def _status_message(intent: str, slots: dict, missing: list) -> dict:
    """
    Build a structured response with action type and dynamic status message.
    The frontend uses 'action' to decide what UI to show.
    """
    query = _extract_query_from_slots(slots) or slots.get("item_code")
    quantity = slots.get("quantity")

    # ── Missing required info — ask user ──
    if missing:
        labels = {
            "item_code": "Item Code",
            "quantity": "Quantity",
            "warehouse": "Warehouse",
            "location": "Location",
            "query": "Reference / Search Keyword",
        }
        fields = ", ".join(labels.get(m, m) for m in missing)
        return {
            "action": "request_info",
            "status": f"Please provide: {fields}",
        }

    # ── Intent-specific responses ──
    if intent == "adjust_quantity":
        return {
            "action": "adjust_quantity",
            "status": f"Adding {quantity} more quantity to '{query}'...",
        }

    if intent == "delete_line":
        return {
            "action": "confirm_delete",
            "status": f"⚠️ Are you sure you want to delete '{query}'? Type 'yes' to confirm.",
        }

    if intent == "open_record":
        return {
            "action": "open_record",
            "status": f"Searching for '{query}'...",
        }

    if intent == "receive_stock":
        return {
            "action": "open_receive_form",
            "status": "Opening Goods Receiving form...",
        }

    if intent == "check_inventory":
        return {
            "action": "show_inventory",
            "status": "Loading inventory data...",
        }

    if intent == "report":
        return {
            "action": "show_report",
            "status": "Generating report...",
        }

    return {"action": "chat_reply", "status": None}


@router.post("/interpret")
def interpret_message(payload: dict):
    message = payload.get("message", "").strip()
    session_id = payload.get("session_id", "default")

    if not message:
        return {
            "intent": "unknown",
            "slots": {},
            "missing": [],
            "action": "chat_reply",
            "status": "Please enter a command.",
            "response": "Please enter a command.",
        }

    # ── Handle pending delete confirmation ──
    if session_id in _pending_deletes:
        query = _pending_deletes.pop(session_id)
        if message.lower() in ("yes", "confirm", "haan", "ha", "y"):
            return {
                "intent": "delete_line",
                "slots": {"query": query},
                "missing": [],
                "action": "execute_delete",
                "status": f"Deleting '{query}'...",
                "response": None,
                "confirmed": True,
            }
        else:
            return {
                "intent": "delete_line",
                "slots": {"query": query},
                "missing": [],
                "action": "delete_cancelled",
                "status": "Delete cancelled.",
                "response": "Delete operation cancelled.",
                "confirmed": False,
            }

    # ── NLP extraction ──
    data = extract_intent_and_slots(message)
    intent = data.get("intent", "unknown")
    slots = data.get("slots", {})
    missing = data.get("missing", [])

    # ── Build action + status ──
    action_data = _status_message(intent, slots, missing)

    # ── Store pending delete for confirmation flow ──
    _store_pending_delete(intent, slots, missing, session_id)

    # ── Fallback chat for unknown intent ──
    response = None
    if intent == "unknown":
        text_low = message.lower()
        # Extended greeting patterns
        greetings = ("hi", "hello", "hey", "assalam", "salam", "good morning", 
                    "good afternoon", "good evening", "greetings", "hola", "namaste")
        help_keywords = ("help", "commands", "kya kar sakte", "how to", "what can",
                        "guide", "instructions", "madad")
        
        if any(w in text_low for w in greetings):
            response = (
                "Assalam-o-alaikum! Main aapka Warehouse Assistant hoon.\n"
                "Stock receive, edit, delete, search — sab yahan se control karein."
            )
        elif any(w in text_low for w in help_keywords):
            response = (
                "Aap yeh commands try karein:\n"
                "• \"receive stock\" — naya stock receive karein\n"
                "• \"add 10 qty in POS-123\" — quantity update karein\n"
                "• \"delete POS-456\" — line delete karein\n"
                "• \"search customer Ali\" — record search karein\n"
                "• \"check inventory\" — inventory dekhein"
            )
        else:
            # Try with normalized message as second pass
            normalized_msg = normalize_message(message)
            if normalized_msg != message:
                # Re-try NLP with normalized message
                retry_data = extract_intent_and_slots(normalized_msg)
                retry_intent = retry_data.get("intent", "unknown")
                if retry_intent != "unknown":
                    # Use the retry result
                    intent = retry_intent
                    slots = retry_data.get("slots", {})
                    missing = retry_data.get("missing", [])
                    action_data = _status_message(intent, slots, missing)
                    _store_pending_delete(intent, slots, missing, session_id)
                else:
                    response = action_data.get("status")
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