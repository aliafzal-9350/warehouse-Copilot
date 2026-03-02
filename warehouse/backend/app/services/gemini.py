"""
gemini.py — Warehouse Copilot AI Brain
========================================
Semantic intent detection via fastembed (ONNX Runtime — no PyTorch needed):
  • fastembed TextEmbedding("all-MiniLM-L6-v2")  — 384-dim ONNX embeddings
  • cosine_similarity (sklearn)                   — ranks intent descriptions
  • spaCy en_core_web_sm                          — NER + POS slot extraction
  • Confidence threshold                          — gates uncertain results

Gemini API is ONLY used for the fallback chat reply (generate_chat_response).
All heavy models are loaded ONCE at module import and reused for every request.
"""

import os
import re
import logging
import numpy as np
from dotenv import load_dotenv
from sklearn.metrics.pairwise import cosine_similarity
import spacy
from fastembed import TextEmbedding

load_dotenv()
logger = logging.getLogger(__name__)

# ── Optional Gemini (only for chat replies) ───────────────────────────────────
API_KEY    = os.getenv("GEMINI_API_KEY")
MODEL_NAME = os.getenv("GEMINI_MODEL", "models/gemini-1.5-flash")

# ─────────────────────────────────────────────────────────────────────────────
# 1. Load AI models once at startup
# ─────────────────────────────────────────────────────────────────────────────

logger.info("Loading fastembed model (all-MiniLM-L6-v2)…")
_embed_model = TextEmbedding("sentence-transformers/all-MiniLM-L6-v2")

logger.info("Loading spaCy en_core_web_sm…")
_nlp = spacy.load("en_core_web_sm")

# ─────────────────────────────────────────────────────────────────────────────
# 2. Intent definitions (semantic, not keywords)
#    The model computes cosine similarity between the user message and each
#    natural-language description to pick the best matching intent.
# ─────────────────────────────────────────────────────────────────────────────

INTENT_DEFINITIONS = {
    "receive_stock": (
        "Open the goods receiving form. User wants to register, enter, record, or log "
        "newly arrived products into the warehouse. Keywords: receive, GRN, inward, "
        "receiving form, log incoming goods, new stock entry, accept shipment."
    ),
    "adjust_quantity": (
        "Update an existing warehouse record's quantity. User wants to add, increase, "
        "or modify the number of units for a specific item, PO reference, or batch number."
    ),
    "delete_line": (
        "Remove or erase an existing warehouse record. User wants to delete, cancel, "
        "or remove a line item, purchase order, or receiving entry."
    ),
    "open_record": (
        "Search and display an existing record. User wants to find, look up, open, "
        "or view details of a warehouse entry by customer name, item name, reference, or batch."
    ),
    "check_inventory": (
        "Display the full inventory list or stock status. User wants to see all items "
        "currently stored, browse stock levels, or view the complete warehouse inventory table."
    ),
    "report": (
        "Generate a warehouse summary or activity report. User wants a daily, "
        "monthly, or overall report of warehouse operations and receiving history."
    ),
}

_INTENT_LABELS: list[str] = list(INTENT_DEFINITIONS.keys())

# Pre-compute intent description embeddings (fast: runs once at startup)
_INTENT_EMBEDDINGS: np.ndarray = np.array(
    list(_embed_model.embed(list(INTENT_DEFINITIONS.values())))
)

# Confidence threshold — below this we return "unknown"
_CONFIDENCE_THRESHOLD = 0.20

# ── Keyword pre-boost map (bypass cosine when intent is unambiguous) ──────────
# Order matters: more-specific patterns first.
_KEYWORD_INTENTS: list[tuple[re.Pattern, str]] = [
    # receive_stock  — must match BEFORE check_inventory to avoid 'stock' confusion
    (re.compile(
        r"\b(receive|receiving|inward|grn|goods\s*receipt|stock\s*entry|receive\s*form"
        r"|naya\s*maal|maal\s*aaya|stock\s*aa|receive\s*karo|enter\s*stock"
        r"|log\s*stock|stock\s*in|incoming\s*goods|accept\s*shipment)\b", re.I
    ), "receive_stock"),
    # check_inventory
    (re.compile(
        r"\b(inventory|all\s*stock|stock\s*list|kitna\s*maal|stock\s*level"
        r"|view\s*stock|see\s*stock|browse\s*stock|show\s*all)\b", re.I
    ), "check_inventory"),
    # report
    (re.compile(
        r"\b(report|daily\s*report|monthly\s*report|summary|activity\s*log)\b", re.I
    ), "report"),
    # delete_line
    (re.compile(
        r"\b(delete|remove|cancel|erase|hata\s*do|nikal\s*do)\b", re.I
    ), "delete_line"),
    # adjust_quantity
    (re.compile(
        r"\b(add\s+\d|increase\s+\d|bump|plus\s+\d|\d+\s+(more|units?|qty|pieces?)|add\s+\w+\s+qty"
        r"|adjust\s+qty|update\s+qty|badha|zyada\s+karo)\b", re.I
    ), "adjust_quantity"),
    # open_record (search, edit, view)
    (re.compile(
        r"\b(search|find|look\s+up|show\s+record|open\s+record|dhundo|dekho|edit|modify|change|update)\b", re.I
    ), "open_record"),
]

# ─────────────────────────────────────────────────────────────────────────────
# 3. Spell-correction dictionary (applied before NLP)
# ─────────────────────────────────────────────────────────────────────────────

_SPELL_CORRECTIONS = {
    "reomve": "remove", "remov": "remove", "rmove": "remove",
    "delet": "delete", "dleet": "delete", "deleet": "delete",
    "serch": "search", "saerch": "search", "sarch": "search",
    "edti": "edit", "eidt": "edit",
    "opne": "open", "oepn": "open",
    "updte": "update", "updae": "update",
    "recieve": "receive", "recive": "receive", "receve": "receive",
    "inventry": "inventory", "inventroy": "inventory", "inventary": "inventory",
    "chek": "check",
    "quantiy": "quantity", "quanity": "quantity", "quntity": "quantity",
    "warehose": "warehouse", "warehoues": "warehouse",
    "custmer": "customer", "customar": "customer", "cusotmer": "customer",
    "cancle": "cancel", "cancl": "cancel",
    "increse": "increase", "increae": "increase",
    "reprot": "report", "reoprt": "report",
    "sumary": "summary", "summry": "summary",
    "stok": "stock", "stck": "stock",
    "aad": "add",
}

# ── Roman Urdu → English warehouse phrase mapping ─────────────────────────────
# When a message contains these patterns, it's translated to English first
# before being fed to the English-only embedding model.
_URDU_PHRASE_MAP: list[tuple[re.Pattern, str]] = [
    # receive / inward
    (re.compile(r"\b(maal|saman)\s*(receive|lao|aaya|add)\b", re.I), "receive stock"),
    (re.compile(r"\b(receive|stock)\s*karo\b", re.I),                "receive stock"),
    (re.compile(r"\bnaya\s*(maal|stock|saman)\b", re.I),             "receive new stock"),
    (re.compile(r"\bmaal\s*aaya\b", re.I),                           "stock received"),
    (re.compile(r"\b(daal|rakh)\s*do\b", re.I),                      "add stock"),
    (re.compile(r"\bjama\s*karo\b", re.I),                           "add to inventory"),
    (re.compile(r"\bstock\s*entry\s*karna\b", re.I),                 "receive stock entry"),
    # inventory / check
    (re.compile(r"\b(kitna|kia)\s*(maal|stock)\s*(hai|hay)?\b", re.I), "how much stock available"),
    (re.compile(r"\b(maal|stock)\s*kitna\s*(hai|hay)?\b", re.I),    "check stock level"),
    (re.compile(r"\b(inventory|stock)\s*(dekho|dikhao)\b", re.I),   "show inventory"),
    (re.compile(r"\bmaloom\s*karo\b", re.I),                         "check inventory"),
    # delete / remove
    (re.compile(r"\b(hata|nikal)\s*(do|dena)\b", re.I), "delete record"),
    (re.compile(r"\b(hatao|nikalo)\b", re.I),            "remove record"),
    # search / edit
    (re.compile(r"\b(dhundo|kholo|dekho|dikhao)\b", re.I), "search open record"),
    # adjust quantity
    (re.compile(r"\baur\s*(daal|add)\b", re.I),   "add more quantity"),
    (re.compile(r"\bbadha\s*do\b", re.I),          "increase quantity"),
    (re.compile(r"\bzyada\s*karo\b", re.I),        "increase quantity"),
    # report
    (re.compile(r"\b(report|summary)\s*(dikhao|chahiye|do)\b", re.I), "show report"),
]


def _translate_urdu(message: str) -> str:
    """
    Detect Roman Urdu warehouse phrases and replace with English equivalents.
    Falls back to the original message if no Urdu pattern is matched.
    """
    translated = message
    for pattern, replacement in _URDU_PHRASE_MAP:
        translated = pattern.sub(replacement, translated)
    return translated

# Reference code pattern: POS-123, PO-1, GRN-45, INV-9, etc.
_REFERENCE_REGEX = r"\b(?:POS|PO|REF|GRN|INV|REC|BATCH|SO|DO)[\-\s]?\d+\b"


# ─────────────────────────────────────────────────────────────────────────────
# Public helpers
# ─────────────────────────────────────────────────────────────────────────────

def normalize_message(message: str) -> str:
    """Apply spell-correction dictionary to the user message."""
    words = message.split()
    out = []
    for word in words:
        clean = word.lower().strip(".,!?;:")
        if clean in _SPELL_CORRECTIONS:
            corrected = _SPELL_CORRECTIONS[clean]
            if len(word) > 1 and word[0].isupper():
                corrected = corrected.capitalize()
            for ch in ".,!?;:":
                if word.endswith(ch):
                    corrected += ch
                    break
            out.append(corrected)
        else:
            out.append(word)
    return " ".join(out)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Semantic Intent Detection  (cosine similarity against ONNX embeddings)
# ─────────────────────────────────────────────────────────────────────────────

def detect_intent(user_message: str) -> tuple[str, float]:
    """
    Two-stage intent detection:
      Stage 1 — Keyword pre-boost: if the message clearly contains a
                 strong intent keyword, return that intent immediately
                 without calling the embedding model. This prevents
                 cosine-similarity confusion when 'stock' appears in
                 both receive_stock and check_inventory contexts.
      Stage 2 — Semantic cosine similarity via ONNX embeddings.
    """
    # Stage 1: keyword rules (ordered, first match wins)
    for pattern, forced_intent in _KEYWORD_INTENTS:
        if pattern.search(user_message):
            return forced_intent, 1.0       # 1.0 = certain

    # Stage 2: semantic embedding
    user_vec     = np.array(list(_embed_model.embed([user_message])))
    similarities = cosine_similarity(user_vec, _INTENT_EMBEDDINGS)[0]

    best_idx   = int(np.argmax(similarities))
    confidence = float(similarities[best_idx])
    intent     = _INTENT_LABELS[best_idx]

    if confidence < _CONFIDENCE_THRESHOLD:
        return "unknown", confidence

    return intent, confidence


# ─────────────────────────────────────────────────────────────────────────────
# 5. Slot Extraction  (spaCy NER + regex)
# ─────────────────────────────────────────────────────────────────────────────

def extract_slots(message: str) -> dict:
    """
    Extract structured parameters from the user message.
    Uses spaCy for named-entity recognition + regex patterns.
    Returns a slots dict compatible with the existing backend route API.
    """
    doc = _nlp(message)

    # ── Quantity ──────────────────────────────────────────────────────────
    quantity = None
    for token in doc:
        if token.like_num:
            try:
                qty = int(token.text)
                if qty > 0:
                    quantity = qty
                    break
            except ValueError:
                pass

    # ── Reference code (POS-123, GRN-45, etc.) ───────────────────────────
    reference_no = None
    ref_match = re.search(_REFERENCE_REGEX, message, re.I)
    if ref_match:
        reference_no = ref_match.group(0).upper()

    # ── Item code (ITEM-A, SKU-10, any all-caps alphanum-dash) ───────────
    item_code = None
    item_match = re.search(r"\b([A-Z]{2,}-[A-Za-z0-9]+)\b", message)
    if item_match and not ref_match:
        item_code = item_match.group(1).upper()

    # ── Customer name (spaCy PERSON / ORG, or "customer <Name>" pattern) ─
    customer = None
    for ent in doc.ents:
        if ent.label_ in ("PERSON", "ORG"):
            customer = ent.text
            break
    if not customer:
        m = re.search(
            r"\b(?:customer|client|cust)\s*[:\-]?\s*([A-Za-z][A-Za-z\s\-]{1,40})",
            message, re.I
        )
        if m:
            customer = m.group(1).strip()

    # ── Batch number ──────────────────────────────────────────────────────
    batch_no = None
    batch_m = re.search(
        r"\b(?:batch|lot)\s*[:\-]?\s*([A-Za-z0-9][\w\-]{1,20})", message, re.I
    )
    if batch_m:
        batch_no = batch_m.group(1).upper()

    # ── Warehouse ─────────────────────────────────────────────────────────
    warehouse = None
    wh_m = re.search(
        r"\b(?:warehouse|wh)\s*[:\-]?\s*([A-Za-z0-9]{1,10})", message, re.I
    )
    if wh_m:
        warehouse = wh_m.group(1).upper()

    # ── Location ──────────────────────────────────────────────────────────
    location = None
    loc_m = re.search(
        r"\b(?:location|loc|shelf|bin|at)\s*[:\-]?\s*([A-Za-z0-9]{1,10})", message, re.I
    )
    if loc_m:
        location = loc_m.group(1).upper()

    # ──  Query / Item name extraction  ──────────────────────────────
    # Priority 1: structured identifiers already extracted
    query = reference_no or item_code or customer or batch_no

    # Priority 2: text after command verbs like "search", "find", "show", etc.
    # e.g. "search ITEM Wire" → "ITEM Wire"  |  "find customer Hessen" → "Hessen"
    if not query:
        _CMD_VERB_RE = re.compile(
            r"^(?:.*\b)?(?:search|find|look\s+up|show|check|view|open|get|display|dhundo|dekho)"
            r"\s+(?:me\s+|all\s+|a\s+|the\s+|some\s+)?"
            r"(?:for\s+)?(?:item\s+|customer\s+|by\s+|record\s+|batch\s+)?",
            re.I
        )
        stripped = _CMD_VERB_RE.sub("", message).strip()
        # Strip trailing generic words like 'records', 'items', 'entry'
        stripped = re.sub(r"\s+(?:records?|items?|entries|entry)$", "", stripped, flags=re.I).strip()
        # Use the stripped phrase as the item name query if it has meaningful content
        if stripped and stripped.lower() not in (
            "inventory", "stock", "all", "report", "records", "all records", ""
        ) and len(stripped) > 1:
            query = re.sub(r"\s+", " ", stripped).strip()

    # Priority 3: first meaningful noun/proper noun from spaCy
    if not query:
        _SKIP_WORDS = {"stock", "inventory", "search", "find", "check",
                       "record", "report", "warehouse", "want", "need"}
        for token in doc:
            if (
                token.pos_ in ("NOUN", "PROPN")
                and not token.is_stop
                and len(token.text) > 1
                and token.text.lower() not in _SKIP_WORDS
            ):
                query = token.text
                break

    # Also store item_name as a dedicated slot (useful for direct item searches)
    item_name = None
    _ITEM_NAME_RE = re.compile(
        r"\b(?:item|product|maal)\s+([A-Za-z][A-Za-z0-9\s\-]{1,30})", re.I
    )
    name_m = _ITEM_NAME_RE.search(message)
    if name_m:
        item_name = name_m.group(1).strip()
        if not query:
            query = item_name

    return {
        "quantity":     quantity,
        "item_code":    item_code,
        "item_name":    item_name,
        "warehouse":    warehouse,
        "location":     location,
        "query":        query,
        "customer":     customer,
        "batch_no":     batch_no,
        "reference_no": reference_no,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 6. Missing-field validation
# ─────────────────────────────────────────────────────────────────────────────

def check_missing(intent: str, slots: dict) -> list[str]:
    """Return a list of required-but-absent slot names for the given intent."""
    missing = []
    if intent == "adjust_quantity":
        if not slots.get("quantity"):
            missing.append("quantity")
        if not slots.get("query"):
            missing.append("item_code or reference")
    elif intent in ("delete_line", "open_record"):
        if not slots.get("query"):
            missing.append("reference / search keyword")
    return missing


# ─────────────────────────────────────────────────────────────────────────────
# 7. Clean professional response generator
# ─────────────────────────────────────────────────────────────────────────────

def generate_response(result: dict) -> str | None:
    """
    Build a short, professional status message based on the intent result.
    This matches the pattern from the user's request.
    """
    confidence = result.get("confidence", 0)
    intent     = result.get("intent", "unknown")
    missing    = result.get("missing", [])
    slots      = result.get("slots", {})
    query      = slots.get("query") or slots.get("reference_no") or slots.get("item_code")
    quantity   = slots.get("quantity")

    if confidence < _CONFIDENCE_THRESHOLD or intent == "unknown":
        return "I'm not sure what you'd like to do. Could you please clarify your request?"

    if missing:
        field_labels = {
            "quantity":               "Quantity",
            "item_code or reference": "Item Code or Reference Number",
            "reference / search keyword": "Reference No. or Search Keyword",
        }
        fields = ", ".join(field_labels.get(f, f) for f in missing)
        return f"Please provide the following information: {fields}."

    _RESPONSES = {
        "receive_stock":   "Opening the Stock Receiving form…",
        "adjust_quantity": (
            f"Adding {quantity} unit(s) to '{query}'…" if (query and quantity)
            else "Updating the record quantity…"
        ),
        "delete_line":     f"Preparing to delete '{query}'…" if query else "Preparing to delete the record…",
        "open_record":     f"Searching for '{query}'…" if query else "Opening requested record…",
        "check_inventory": "Loading current inventory levels…",
        "report":          "Generating warehouse report…",
    }
    return _RESPONSES.get(intent, "Processing your request…")


# ─────────────────────────────────────────────────────────────────────────────
# 8. Main public entry point  (API unchanged — routes/chat.py needs no edits)
# ─────────────────────────────────────────────────────────────────────────────

def extract_intent_and_slots(message: str) -> dict:
    """
    Full semantic pipeline:
      1. Spell-correct the message
      2. Translate Roman Urdu warehouse phrases → English
      3. Detect intent via cosine similarity on ONNX embeddings
      4. Extract slots via spaCy NER + regex (on spell-corrected original)
      5. Validate missing required fields
    Returns {intent, confidence, slots, missing}
    """
    normalized         = normalize_message(message)
    translated         = _translate_urdu(normalized)      # Urdu → English for embedding
    intent, confidence = detect_intent(translated)
    slots              = extract_slots(normalized)        # slots from spell-corrected text
    missing            = check_missing(intent, slots)

    return {
        "intent":     intent,
        "confidence": round(confidence, 3),
        "slots":      slots,
        "missing":    missing,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 9. Gemini-powered fallback chat reply  (for greetings / unknown intents)
# ─────────────────────────────────────────────────────────────────────────────

_CHAT_SYSTEM_PROMPT = """
You are a professional warehouse management assistant.
Answer in English or Roman Urdu — short and professional (1-2 sentences).
If the question is not warehouse-related, politely guide the user:
"I can assist with receiving stock, checking inventory, editing records, deletions, and reports."

Quick command examples:
- "receive 50 ITEM-A in WH1 at A1"
- "add 10 qty in POS-123"
- "delete POS-456"
- "search customer Ali"
- "check inventory"
"""


def generate_chat_response(message: str) -> str:
    """Generate a conversational reply using Gemini API (for greetings / unknown messages)."""
    if not API_KEY:
        return (
            "I can assist with receiving stock, checking inventory, "
            "editing records, deletions, and reports."
        )
    try:
        from google import genai
        client   = genai.Client(api_key=API_KEY)
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=f"{_CHAT_SYSTEM_PROMPT}\nUser: {message}\nAnswer:",
        )
        return response.text.strip()
    except Exception:
        return "I can help with receiving stock, checking inventory, editing, deleting, and reports."