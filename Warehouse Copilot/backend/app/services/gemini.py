import os
import json
import re
from dotenv import load_dotenv
from google import genai

load_dotenv()

API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = os.getenv("GEMINI_MODEL", "models/gemini-1.5-flash")

# ── Reference pattern covers POS-123, PO 456, GRN-78, SO-9, DO-10, etc. ──
REFERENCE_REGEX = r"\b(?:POS|PO|REF|GRN|INV|REC|BATCH|SO|DO)[\-\s]?\d+\b"


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────���──────────────────────

def _clean(value: str | None) -> str | None:
    if not value:
        return None
    return re.sub(r"\s+", " ", value).strip() or None


def _extract_quantity(message: str) -> int | None:
    m = re.search(r"\b(\d+)\b", message)
    return int(m.group(1)) if m else None


def _extract_query(message: str) -> str | None:
    """
    Extracts the most likely search term from a user message.
    Priority order:
      1. Structured reference codes  (POS-123, GRN-45 …)
      2. Tagged keywords              (customer: Ali, batch: B-01 …)
      3. Quoted strings               ("Irtaza Traders")
      4. Token after a number         (10 ITEM-A  → ITEM-A)
      5. First meaningful alpha token
    """
    text = message.strip()

    # 1 — reference code
    ref = re.search(REFERENCE_REGEX, text, re.I)
    if ref:
        return ref.group(0)

    # 2 — tagged keyword (supports multi-word: customer: Ali Afzal)
    tagged = re.search(
        r"\b(?:customer|batch|item|reference|ref|pos|po|grn|name|warehouse|wh)"
        r"\s*[:\-]?\s*"
        r"([A-Za-z0-9][A-Za-z0-9\s\-_]{0,40})",
        text, re.I,
    )
    if tagged:
        # Trim trailing noise words that are likely part of the sentence
        raw = tagged.group(1)
        raw = re.split(r"\b(?:item|line|record|row|entry|quantity|qty|se|ka|ki|ko|mein|men|say)\b", raw, flags=re.I)[0]
        return _clean(raw)

    # 3 — quoted string
    quoted = re.search(r"[\"']([^\"']+)[\"']", text)
    if quoted:
        return _clean(quoted.group(1))

    # 4 — token after a number  ("add 10 in ITEM-A")
    qty_m = re.search(r"\b\d+\b", text)
    if qty_m:
        after = text[qty_m.end():].strip()
        # skip common filler words
        after = re.sub(r"^(?:more\s+)?(?:quantity|qty|pieces?|units?|items?|in|of|for|to|into)\s+", "", after, flags=re.I)
        tok = re.search(r"\b([A-Za-z][A-Za-z0-9\-_]+)\b", after)
        if tok:
            return tok.group(1)

    # 5 — first meaningful alpha token (skip common verbs)
    skip = {
        "i", "want", "to", "the", "a", "an", "please", "show", "me",
        "can", "you", "find", "search", "open", "edit", "update",
        "delete", "remove", "add", "increase", "more", "of", "in",
        "for", "get", "check", "mujhe", "karo", "do", "bata", "dikhao",
    }
    for tok in re.findall(r"\b([A-Za-z][A-Za-z0-9\-_]*)\b", text):
        if tok.lower() not in skip and len(tok) > 1:
            return tok

    return None


# ──────────────────────────────────────────────────────────────────────────
# Intent detection  (rule-based fallback)
# ──────────────────────────────────────────────────────────────────────────

_DELETE_KW = [
    "delete", "remove", "drop", "cancel", "erase",
    "hata do", "nikaal do", "nikalo", "hatao",
]
_ADJUST_KW = [
    "add", "increase", "more", "extra", "plus",
    "qty add", "update quantity", "enter", "put more",
    "aur daal", "aur add", "badha do", "zyada karo",
]
_EDIT_KW = [
    "edit", "update", "change", "open", "modify",
    "show record", "show details", "find", "search",
    "kholo", "dikhao", "dekho", "dhundo",
]
_RECEIVE_KW = [
    "receive", "recv", "inward", "stock up", "add stock", "restock",
    "stock add", "maal add", "add item", "add items", "put stock",
    "put item", "store", "keep", "incoming", "goods in", "grn",
    "saman add", "store stock", "stock receive", "item add",
    "jama karo", "daal do", "rakh do",
]


def _detect_intent(text: str, quantity: int | None, query: str | None) -> str:
    low = text.lower()

    if any(k in low for k in _DELETE_KW) and query:
        return "delete_line"
    if any(k in low for k in _ADJUST_KW) and quantity and query:
        return "adjust_quantity"
    if any(k in low for k in _EDIT_KW) and query:
        return "open_record"
    if any(k in low for k in _RECEIVE_KW):
        return "receive_stock"
    if any(k in low for k in ("inventory", "stock level", "stock status", "maloom karo")):
        return "check_inventory"
    if any(k in low for k in ("report", "summary")):
        return "report"
    return "unknown"


def _get_missing(intent: str, slots: dict) -> list[str]:
    if intent == "receive_stock":
        return [
            k for k in ("item_code", "quantity", "warehouse", "location")
            if slots.get(k) in (None, "", 0)
        ]
    if intent == "adjust_quantity":
        return [k for k in ("quantity", "query") if slots.get(k) in (None, "", 0)]
    if intent in ("delete_line", "open_record"):
        return ["query"] if not slots.get("query") else []
    return []


def _fallback_parse(message: str) -> dict:
    quantity = _extract_quantity(message)
    query = _extract_query(message)
    intent = _detect_intent(message, quantity, query)
    slots = {
        "item_code": None,
        "quantity": quantity,
        "warehouse": None,
        "location": None,
        "query": query,
    }
    return {
        "intent": intent,
        "slots": slots,
        "missing": _get_missing(intent, slots),
    }


# ──────────────────────────────────────────────────────────────────────────
# Gemini-powered extraction
# ──────────────────────────────────────────────────────────────────────────

_ALLOWED_INTENTS = frozenset([
    "receive_stock", "check_inventory", "report",
    "adjust_quantity", "delete_line", "open_record",
])

_SYSTEM_PROMPT = f"""
You are an industrial warehouse management assistant.
Classify the user's intent and extract slots from their message.
Return ONLY valid JSON — no markdown, no explanation.

Schema:
{{
  "intent": "receive_stock" | "check_inventory" | "report" | "adjust_quantity" | "delete_line" | "open_record" | "unknown",
  "slots": {{
    "item_code": null,
    "quantity": null,
    "warehouse": null,
    "location": null,
    "query": null,
    "customer": null,
    "batch_no": null,
    "reference_no": null
  }}
}}

Intent rules & examples:
─────────────────────────
adjust_quantity — user wants to ADD / INCREASE quantity on an existing record
  • "add 10 more quantity in POS-123"        → intent=adjust_quantity, quantity=10, query="POS-123"
  • "increase qty of PO-01 by 5"             → intent=adjust_quantity, quantity=5, query="PO-01"
  • "enter 20 units in batch BATCH-5"        → intent=adjust_quantity, quantity=20, query="BATCH-5"
  • "POS-456 mein 15 aur daal do"            → intent=adjust_quantity, quantity=15, query="POS-456"

delete_line — user wants to DELETE / REMOVE a record or line
  • "delete POS-123 item line"               → intent=delete_line, query="POS-123"
  • "remove batch BATCH-9"                   → intent=delete_line, query="BATCH-9"
  • "cancel GRN-45"                          → intent=delete_line, query="GRN-45"
  • "POS-789 hata do"                        → intent=delete_line, query="POS-789"

open_record — user wants to VIEW / EDIT / SEARCH / FIND a record
  • "show record of customer irtaza"         → intent=open_record, query="irtaza", customer="irtaza"
  • "edit customer ali"                      → intent=open_record, query="ali", customer="ali"
  • "open batch BATCH-8"                     → intent=open_record, query="BATCH-8", batch_no="BATCH-8"
  • "search POS-123"                         → intent=open_record, query="POS-123", reference_no="POS-123"
  • "find item ITEM-A"                       → intent=open_record, query="ITEM-A", item_code="ITEM-A"
  • "POS-999 dikhao"                         → intent=open_record, query="POS-999"

receive_stock — user wants to receive NEW stock
  • "receive 50 ITEM-A in WH1 at A1"        → intent=receive_stock, item_code="ITEM-A", quantity=50, warehouse="WH1", location="A1"
  • "stock receive karo"                     → intent=receive_stock

check_inventory — user wants to CHECK current inventory / stock levels
  • "check inventory"                        → intent=check_inventory
  • "stock level dikhao"                     → intent=check_inventory

report — user wants a REPORT or SUMMARY
  • "show receiving report"                  → intent=report

Reference patterns like {REFERENCE_REGEX} are strong candidates for "query".
Customer names, batch numbers, item codes should also populate "query".
If a value is not mentioned, set it to null.
"""


def extract_intent_and_slots(message: str) -> dict:
    """Main entry point — returns {{intent, slots, missing}}."""
    if not API_KEY:
        return _fallback_parse(message)

    try:
        client = genai.Client(api_key=API_KEY)
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=f"{_SYSTEM_PROMPT}\nUser: {message}\nJSON:",
        )

        raw = response.text.strip()
        json_match = re.search(r"\{[\s\S]*\}", raw)
        parsed = json.loads(json_match.group(0) if json_match else raw)

        intent = parsed.get("intent", "unknown")
        slots = parsed.get("slots", {})

        # Normalise
        slots.setdefault("query", None)
        slots.setdefault("customer", None)
        slots.setdefault("batch_no", None)
        slots.setdefault("reference_no", None)

        if intent not in _ALLOWED_INTENTS:
            intent = "unknown"

        # Auto-fill query from specific slot if Gemini left it empty
        if not slots.get("query"):
            slots["query"] = (
                slots.get("reference_no")
                or slots.get("customer")
                or slots.get("batch_no")
                or slots.get("item_code")
            )

        missing = _get_missing(intent, slots)
        return {"intent": intent, "slots": slots, "missing": missing}

    except Exception:
        return _fallback_parse(message)


# ──────────────────────────────────────────────────────────────────────────
# Chat response generation
# ──────────────────────────────────────────────────────────────────────────

_CHAT_SYSTEM_PROMPT = """
Aap ek professional warehouse assistant chatbot hain.
Jawab Roman Urdu / English mein dein — short aur professional (1-2 sentences).
Agar sawal warehouse se related na ho to politely guide karein:
"Main aapko stock receive, inventory check, edit, delete, aur reports mein madad de sakta hoon."

Quick-help examples:
- "receive 50 ITEM-A in WH1 at A1"
- "add 10 qty in POS-123"
- "delete POS-456"
- "search customer Ali"
- "check inventory"
"""


def generate_chat_response(message: str) -> str:
    if not API_KEY:
        return (
            "Main aapko stock receive, inventory check, edit, delete, "
            "aur reports mein madad de sakta hoon."
        )
    try:
        client = genai.Client(api_key=API_KEY)
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=f"{_CHAT_SYSTEM_PROMPT}\nUser: {message}\nAnswer:",
        )
        return response.text.strip()
    except Exception:
        return "I can help with receiving stock, checking inventory, editing, deleting, and reports."