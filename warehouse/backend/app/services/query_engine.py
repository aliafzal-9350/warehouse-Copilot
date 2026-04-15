"""
query_engine.py  –  Warehouse Copilot NL-to-SQL (MySQL, normalised schema)
Zero API calls for all built-in queries. Gemini only as last-resort fallback.
"""

import os, re, logging
from datetime import date
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

API_KEY    = os.getenv("GEMINI_API_KEY")
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

# ── The 4-table JOIN that every query MUST use ──────────────────────────────
J = (
    " FROM receiving_lines rl"
    " JOIN receiving_headers rh ON rl.receiving_id = rh.id"
    " JOIN items i             ON rl.item_id      = i.id"
    " JOIN warehouses w        ON rh.warehouse_id  = w.id"
    " JOIN locations loc       ON rl.location_id   = loc.id"
)

FULL = (
    "rh.customer, rh.receiving_date, rh.reference_no,"
    " w.code AS warehouse, i.code AS item, loc.code AS location,"
    " rl.batch_no, rl.quantity, rl.status,"
    " rl.manufacturing_date, rl.expiry_date, rl.shelf_expiry_date"
)

SCHEMA_PROMPT = f"""You are a MySQL SQL expert. Today is {date.today().isoformat()}.
Tables: receiving_headers(id,customer,receiving_date,warehouse_id FK->warehouses.id,reference_no,created_at),
receiving_lines(id,receiving_id FK->receiving_headers.id,item_id FK->items.id,location_id FK->locations.id,batch_no,manufacturing_date,expiry_date,shelf_expiry_date,quantity,status),
items(id,code,name), warehouses(id,code,name), locations(id,code,warehouse_id).
ALWAYS JOIN all 4 tables. warehouse code is in w.code NOT rh.warehouse. item code is i.code NOT rl.item_code.
MySQL only: CURDATE(), DATEDIFF(), MONTH(), YEAR(), DATE_FORMAT(), DATE_ADD/SUB.
SELECT only. No markdown. Raw SQL only."""


# ── Chart type hint: tells frontend what chart to render ────────────────────
# Returns (sql, chart_type) where chart_type is one of:
# "bar", "pie", "line", "doughnut", "horizontal_bar", None

def _q(question: str):
    """Try to match question to a known SQL pattern. Returns (SQL, chart_type) or None."""
    q = question.lower().strip().rstrip("?. !")

    # 1  Total stock per warehouse
    if re.search(r"(total|sum).*(stock|quantity|receiving).*(every|each|all|per|by)\s*warehouse", q):
        return (f"SELECT w.code AS warehouse, SUM(rl.quantity) AS total_quantity, COUNT(rl.id) AS total_items{J} GROUP BY w.code ORDER BY total_quantity DESC", "bar")

    # 2  Total stock globally
    if re.search(r"(total|sum|overall|grand).*(stock|quantity|units?).*(global|all|overall|entire|everything)", q):
        return ("SELECT SUM(quantity) AS total_global_quantity, COUNT(id) AS total_line_items FROM receiving_lines", None)

    # 3  Specific item stock globally
    m = re.search(r"(?:total\s+)?(?:stock|quantity|units?|how\s+many)\s+(?:of\s+)?([a-z][a-z0-9\-]+)(?:\s+globally)?", q)
    if m and m.group(1) not in {"items","stock","all","every","damaged","ok","the","each","per","in","are","is","today","available","warehouse","all"}:
        item = m.group(1)
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.quantity, rl.batch_no, rl.status, rh.receiving_date, rh.customer{J} WHERE LOWER(i.code)='{item}' ORDER BY rh.receiving_date DESC", "bar")

    # 4  Sum of item qty per warehouse
    m2 = re.search(r"sum\s+(?:of\s+)?(?:the\s+)?(?:quantity|stock|units?)\s+(?:of\s+)?([a-z][a-z0-9\-]+)\s+(?:in\s+)?(?:every|each|all|per)\s*warehouse", q)
    if m2:
        return (f"SELECT i.code AS item, w.code AS warehouse, SUM(rl.quantity) AS total_quantity{J} WHERE LOWER(i.code)='{m2.group(1)}' GROUP BY i.code, w.code ORDER BY total_quantity DESC", "bar")

    # 5  List damaged items
    if re.search(r"(list|show|all|every|get)\s*(the\s+)?(damaged|broken)\s*(items?|stock|products?|goods?)", q):
        wm = re.search(r"(wh\d)", q, re.I)
        wf = f" AND w.code='{wm.group(1).upper()}'" if wm else ""
        return (f"SELECT i.code AS item, w.code AS warehouse, loc.code AS location, rl.quantity, rl.batch_no, rh.customer, rh.receiving_date, rl.expiry_date{J} WHERE rl.status='damaged'{wf} ORDER BY rl.quantity ASC", None)

    # 6  Today damaged arrivals
    if re.search(r"today.*(?:arrival|receiving).*damaged|damaged.*(?:arrival|receiving).*today", q):
        return (f"SELECT {FULL}{J} WHERE rh.receiving_date=CURDATE() AND rl.status='damaged' ORDER BY rh.id", None)

    # 7  Total damaged per warehouse
    if re.search(r"(total|sum|count|how\s+many).*(damaged)", q):
        return (f"SELECT w.code AS warehouse, COUNT(rl.id) AS damaged_count, SUM(rl.quantity) AS damaged_total_qty{J} WHERE rl.status='damaged' GROUP BY w.code ORDER BY damaged_total_qty DESC", "bar")

    # 8  OK vs Damaged
    if re.search(r"(available|ok)\s*(vs|versus|compared|and|or)\s*(damaged|reserved|held)", q):
        return ("SELECT status, COUNT(id) AS item_count, SUM(quantity) AS total_quantity, ROUND(100.0*SUM(quantity)/(SELECT SUM(quantity) FROM receiving_lines),1) AS percentage FROM receiving_lines GROUP BY status ORDER BY total_quantity DESC", "doughnut")

    # 9  Compare two warehouses
    wc = re.findall(r"(wh\d)", q, re.I)
    if len(wc) >= 2 and re.search(r"compar", q):
        w1, w2 = wc[0].upper(), wc[1].upper()
        return (f"SELECT w.code AS warehouse, COUNT(rl.id) AS total_items, SUM(rl.quantity) AS total_qty, SUM(CASE WHEN rl.status='damaged' THEN rl.quantity ELSE 0 END) AS damaged_qty, SUM(CASE WHEN rl.status='ok' THEN rl.quantity ELSE 0 END) AS ok_qty, ROUND(AVG(rl.quantity),1) AS avg_qty{J} WHERE w.code IN('{w1}','{w2}') GROUP BY w.code ORDER BY w.code", "bar")

    # 10 Rank warehouses
    if re.search(r"rank\s*warehouse", q):
        return (f"SELECT w.code AS warehouse, SUM(rl.quantity) AS total_quantity, COUNT(rl.id) AS total_items, SUM(CASE WHEN rl.status='damaged' THEN 1 ELSE 0 END) AS damaged_items, ROUND(100.0*SUM(CASE WHEN rl.status='damaged' THEN rl.quantity ELSE 0 END)/NULLIF(SUM(rl.quantity),0),1) AS damaged_pct{J} GROUP BY w.code ORDER BY total_quantity DESC", "horizontal_bar")

    # 11 Top supplier / customer
    if re.search(r"top\s*(supplier|customer|vendor)", q):
        return (f"SELECT rh.customer AS supplier, SUM(rl.quantity) AS total_quantity, COUNT(rl.id) AS total_transactions, ROUND(AVG(rl.quantity),1) AS avg_qty{J} GROUP BY rh.customer ORDER BY total_quantity DESC LIMIT 10", "bar")

    # 12 Top N items
    tn = re.search(r"(?:top|highest|biggest)\s*(\d+)\s*(items?|products?|expensive|stock)", q)
    if tn:
        n = min(int(tn.group(1)), 100)
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.quantity, rl.batch_no, rh.customer, rh.receiving_date, rl.status{J} ORDER BY rl.quantity DESC LIMIT {n}", "horizontal_bar")

    # 13 Bottom / lowest
    if re.search(r"(bottom|lowest|least|minimum)\s*(\d+)?\s*(items?|quantity|stock)", q):
        nm = re.search(r"(\d+)", q)
        n = min(int(nm.group(1)), 100) if nm else 10
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.quantity, rl.status, rh.customer, rh.receiving_date{J} ORDER BY rl.quantity ASC LIMIT {n}", "horizontal_bar")

    # 14 Zero stock
    if re.search(r"(zero|no)\s*(stock|quantity|units)", q):
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.quantity, rl.status, rh.customer{J} WHERE rl.quantity=0 OR rl.quantity IS NULL ORDER BY i.code", None)

    # 15 Below safety level
    if re.search(r"(below|under|less\s+than)\s*(safety|threshold|minimum|reorder|\d+)", q):
        lv = re.search(r"(\d+)", q)
        level = int(lv.group(1)) if lv else 15
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.quantity, rl.status, rl.batch_no, rh.receiving_date{J} WHERE rl.quantity<{level} ORDER BY rl.quantity ASC", "bar")

    # 16 Expiring in N days
    em = re.search(r"expir\w*\s*(?:in|within|next)\s*(?:the\s+)?(\d+)\s*days?", q)
    if em:
        d = int(em.group(1))
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.expiry_date, rl.shelf_expiry_date, DATEDIFF(rl.expiry_date,CURDATE()) AS days_until_expiry, rl.quantity, rl.batch_no, rh.customer{J} WHERE rl.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(),INTERVAL {d} DAY) ORDER BY rl.expiry_date ASC", None)

    # 17 Already expired
    if re.search(r"(already\s+)?expir(ed|y\s+.*pass)", q):
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.expiry_date, DATEDIFF(CURDATE(),rl.expiry_date) AS days_past_expiry, rl.quantity, rl.batch_no, rh.customer, rl.status{J} WHERE rl.expiry_date<CURDATE() ORDER BY rl.expiry_date ASC", None)

    # 18 By customer name
    cm = re.search(r"(?:what\s+did|show|list|receiving\s+(?:by|from|for)|received\s+by|items?\s+(?:from|by|for))\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)", question)
    if cm:
        name = cm.group(1).strip()
        return (f"SELECT rh.customer, rh.receiving_date, rh.reference_no, w.code AS warehouse, i.code AS item, loc.code AS location, rl.quantity, rl.batch_no, rl.status, rl.expiry_date{J} WHERE rh.customer LIKE '%{name}%' ORDER BY rh.receiving_date DESC", None)

    # 19 By PO reference
    pm = re.search(r"(po[\-\s]?\d+)", q, re.I)
    if pm:
        ref = pm.group(1).upper().replace(" ", "-")
        return (f"SELECT {FULL}{J} WHERE rh.reference_no='{ref}' ORDER BY rl.id", None)

    # 20 By month/year
    mm = re.search(r"(?:received|receiving|arrivals?).*(?:in|during|for)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})?", q)
    if mm:
        mp = {"january":1,"february":2,"march":3,"april":4,"may":5,"june":6,"july":7,"august":8,"september":9,"october":10,"november":11,"december":12}
        mn = mp[mm.group(1)]
        yr = mm.group(2) or "2024"
        return (f"SELECT rh.customer, rh.receiving_date, rh.reference_no, w.code AS warehouse, i.code AS item, rl.quantity, rl.status{J} WHERE MONTH(rh.receiving_date)={mn} AND YEAR(rh.receiving_date)={yr} ORDER BY rh.receiving_date, rh.id", None)

    # 21 Receiving volume by warehouse
    if re.search(r"(receiving|inbound)\s*(volume|count|total)\s*(by|per)\s*warehouse", q):
        return (f"SELECT w.code AS warehouse, COUNT(rh.id) AS total_receivings, SUM(rl.quantity) AS total_quantity, ROUND(AVG(rl.quantity),1) AS avg_qty, MIN(rh.receiving_date) AS earliest, MAX(rh.receiving_date) AS latest{J} GROUP BY w.code ORDER BY total_quantity DESC", "bar")

    # 22 Average quantity
    if re.search(r"average\s*(quantity|qty)", q):
        return ("SELECT ROUND(AVG(quantity),2) AS avg_quantity, MIN(quantity) AS min_qty, MAX(quantity) AS max_qty, COUNT(id) AS total_transactions FROM receiving_lines", None)

    # 23 Monthly trend
    if re.search(r"monthly\s*(receiving|inbound)?\s*(trend|pattern|history|volume)", q):
        return (f"SELECT DATE_FORMAT(rh.receiving_date,'%Y-%m') AS month, COUNT(rh.id) AS transactions, SUM(rl.quantity) AS total_qty, ROUND(AVG(rl.quantity),1) AS avg_qty, SUM(CASE WHEN rl.status='damaged' THEN 1 ELSE 0 END) AS damaged_count{J} GROUP BY DATE_FORMAT(rh.receiving_date,'%Y-%m') ORDER BY month", "line")

    # 24 A1 vs A2
    if re.search(r"(a1|a2).*(vs|versus|or|compared|and).*(a1|a2)", q, re.I):
        return (f"SELECT loc.code AS location, COUNT(rl.id) AS total_items, SUM(rl.quantity) AS total_qty, SUM(CASE WHEN rl.status='damaged' THEN rl.quantity ELSE 0 END) AS damaged_qty, SUM(CASE WHEN rl.status='ok' THEN rl.quantity ELSE 0 END) AS ok_qty{J} GROUP BY loc.code ORDER BY loc.code", "bar")

    # 25 Which warehouse most damaged
    if re.search(r"which\s*warehouse.*(most|highest|maximum)\s*damaged", q):
        return (f"SELECT w.code AS warehouse, COUNT(rl.id) AS damaged_count, SUM(rl.quantity) AS damaged_qty{J} WHERE rl.status='damaged' GROUP BY w.code ORDER BY damaged_qty DESC LIMIT 1", "pie")

    # 26 ABC analysis
    if re.search(r"abc\s*analysis", q):
        return (f"SELECT i.code AS item, SUM(rl.quantity) AS total_qty{J} GROUP BY i.code ORDER BY total_qty DESC", "horizontal_bar")

    # 27 Items in specific warehouse
    wi = re.search(r"(?:items?|stock|products?|everything)\s*(?:in|at|for)\s*(wh\d)", q, re.I)
    if wi:
        return (f"SELECT i.code AS item, loc.code AS location, rl.quantity, rl.batch_no, rl.status, rh.customer, rh.receiving_date, rh.reference_no, rl.expiry_date{J} WHERE w.code='{wi.group(1).upper()}' ORDER BY rh.receiving_date DESC", None)

    # 28 Total in specific warehouse
    tw = re.search(r"total\s*(?:stock|quantity|units?|inventory)\s*(?:in|at|for)\s*(wh\d)", q, re.I)
    if tw:
        wh = tw.group(1).upper()
        return (f"SELECT w.code AS warehouse, SUM(rl.quantity) AS total_qty, COUNT(rl.id) AS total_items, SUM(CASE WHEN rl.status='ok' THEN rl.quantity ELSE 0 END) AS ok_qty, SUM(CASE WHEN rl.status='damaged' THEN rl.quantity ELSE 0 END) AS damaged_qty{J} WHERE w.code='{wh}' GROUP BY w.code", "doughnut")

    # 29 Item qty in specific warehouse
    iw = re.search(r"(?:how\s+many|quantity|units?|stock)\s+(?:of\s+)?([a-z][a-z0-9\-]+)\s+(?:are\s+)?(?:in|at)\s+(wh\d)", q, re.I)
    if iw:
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.quantity, rl.batch_no, rl.status, rh.customer, rh.receiving_date{J} WHERE LOWER(i.code)='{iw.group(1).lower()}' AND w.code='{iw.group(2).upper()}'", None)

    # 30 Top N customers
    if re.search(r"top\s*(\d*)\s*customer", q):
        nm = re.search(r"(\d+)", q)
        n = min(int(nm.group(1)), 50) if nm else 5
        return (f"SELECT rh.customer, SUM(rl.quantity) AS total_qty, COUNT(rl.id) AS transactions, ROUND(AVG(rl.quantity),1) AS avg_qty{J} GROUP BY rh.customer ORDER BY total_qty DESC LIMIT {n}", "bar")

    # 31 Most transactions
    if re.search(r"(which|who)\s*(customer|supplier).*(most|highest|maximum)\s*(receiving|transaction)", q):
        return (f"SELECT rh.customer, COUNT(rh.id) AS transaction_count, SUM(rl.quantity) AS total_qty{J} GROUP BY rh.customer ORDER BY transaction_count DESC LIMIT 10", "bar")

    # 32 Shelf expiry gap
    if re.search(r"shelf\s*expir", q):
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.expiry_date, rl.shelf_expiry_date, DATEDIFF(rl.expiry_date,rl.shelf_expiry_date) AS shelf_gap_days, rl.quantity, rl.status{J} WHERE rl.shelf_expiry_date IS NOT NULL ORDER BY shelf_gap_days DESC", None)

    # 33 What received today
    if re.search(r"(?:what|show|list)\s*(?:did\s+)?(?:i|we)\s*receiv\w*\s*today", q):
        return (f"SELECT {FULL}{J} WHERE rh.receiving_date=CURDATE() ORDER BY rh.id", None)

    # 34 Summarize / last 24h
    if re.search(r"(summarize|summary|last\s*24\s*hours?)", q) and re.search(r"receiv", q):
        return (f"SELECT w.code AS warehouse, COUNT(rl.id) AS items_received, SUM(rl.quantity) AS total_qty, SUM(CASE WHEN rl.status='damaged' THEN 1 ELSE 0 END) AS damaged_count{J} WHERE rh.receiving_date>=DATE_SUB(CURDATE(),INTERVAL 1 DAY) GROUP BY w.code ORDER BY total_qty DESC", "bar")

    # 35 Stale stock
    sm = re.search(r"(?:hasn.?t|not)\s*moved\s*(?:in|for)\s*(\d+)\s*days?", q)
    if sm:
        d = int(sm.group(1))
        return (f"SELECT i.code AS item, w.code AS warehouse, rl.quantity, rh.receiving_date, DATEDIFF(CURDATE(),rh.receiving_date) AS days_since_receiving, rl.status{J} WHERE rh.receiving_date<DATE_SUB(CURDATE(),INTERVAL {d} DAY) ORDER BY rh.receiving_date ASC", None)

    # 36 Customer-wise breakdown (chart)
    if re.search(r"(customer|supplier)\s*(wise|breakdown|distribution|split|by\s+customer)", q):
        return (f"SELECT rh.customer, SUM(rl.quantity) AS total_qty, COUNT(rl.id) AS items{J} GROUP BY rh.customer ORDER BY total_qty DESC", "pie")

    # 37 Warehouse utilization / capacity
    if re.search(r"(warehouse|wh)\s*(utilization|usage|capacity|load|fill)", q):
        return (f"SELECT w.code AS warehouse, COUNT(DISTINCT i.id) AS unique_items, SUM(rl.quantity) AS total_qty, COUNT(rl.id) AS total_lines, SUM(CASE WHEN rl.status='ok' THEN rl.quantity ELSE 0 END) AS usable_qty{J} GROUP BY w.code ORDER BY total_qty DESC", "bar")

    # 38 Status distribution (pie)
    if re.search(r"(status|condition)\s*(distribution|breakdown|split|overview|pie)", q):
        return ("SELECT status, COUNT(id) AS count, SUM(quantity) AS total_qty FROM receiving_lines GROUP BY status", "pie")

    # 39 Damaged percentage per warehouse
    if re.search(r"damaged\s*(percentage|percent|ratio|rate)\s*(per|by|each)?\s*warehouse", q):
        return (f"SELECT w.code AS warehouse, ROUND(100.0*SUM(CASE WHEN rl.status='damaged' THEN rl.quantity ELSE 0 END)/NULLIF(SUM(rl.quantity),0),1) AS damaged_pct, SUM(rl.quantity) AS total_qty{J} GROUP BY w.code ORDER BY damaged_pct DESC", "bar")

    # 40 Location-wise stock
    if re.search(r"(location|loc)\s*(wise|breakdown|distribution|stock)", q):
        return (f"SELECT loc.code AS location, w.code AS warehouse, SUM(rl.quantity) AS total_qty, COUNT(rl.id) AS items{J} GROUP BY loc.code, w.code ORDER BY total_qty DESC", "bar")

    return None


def generate_sql_from_question(question: str) -> tuple:
    """Returns (sql, chart_type). chart_type may be None."""
    result = _q(question)
    if result:
        sql, chart_type = result
        logger.info("Pattern matched: %s", question[:60])
        return (sql.strip().rstrip(";") + ";", chart_type)

    # Gemini fallback
    if API_KEY:
        try:
            from google import genai
            client = genai.Client(api_key=API_KEY)
            r = client.models.generate_content(model=MODEL_NAME,
                contents=f"{SCHEMA_PROMPT}\n\nQuestion: {question}\n\nSQL:")
            s = re.sub(r"^```(?:sql)?\s*","", r.text.strip(), flags=re.I)
            s = re.sub(r"\s*```$","", s)
            return (s.strip().rstrip(";") + ";", None)
        except Exception as e:
            logger.warning("Gemini fallback failed: %s", e)

    raise ValueError(
        "I couldn't understand that question. Try one of these:\n\n"
        "📦 Stock: \"Total stock in every warehouse\"\n"
        "⚠️ Damage: \"List all damaged items\"\n"
        "📅 Expiry: \"Show items expiring in 30 days\"\n"
        "📊 Compare: \"Compare stock between WH1 and WH2\"\n"
        "👤 Supplier: \"Who is the top supplier\"\n"
        "📈 Trend: \"Monthly receiving trend\"\n"
        "🔍 Search: \"What did Ali Hassan receive\""
    )


def sanitize_sql(sql: str) -> str:
    c = re.sub(r"--.*$", "", sql, flags=re.MULTILINE)
    c = re.sub(r"/\*.*?\*/", "", c, flags=re.DOTALL).strip()
    for kw in ("INSERT","UPDATE","DELETE","DROP","ALTER","CREATE","TRUNCATE","GRANT","REVOKE"):
        if re.search(rf"\b{kw}\b", c, re.I):
            raise ValueError(f"Write operations not allowed (found {kw}).")
    if not re.match(r"^\s*(SELECT|WITH)\b", c, re.I):
        raise ValueError("Only SELECT queries allowed.")
    return c


def format_query_results(question: str, columns: list[str], rows: list[dict]) -> str:
    if not rows:
        return "📭 No data found matching your question."
    total = len(rows)
    if len(columns) == 1 and total == 1:
        col = columns[0].replace("_", " ").title()
        return f"📊 **{col}:** {list(rows[0].values())[0]}"
    if total == 1 and len(columns) <= 6:
        parts = [f"**{c.replace('_',' ').title()}:** {v if v is not None else '—'}" for c, v in rows[0].items()]
        return "📊 " + " | ".join(parts)
    if total <= 20:
        lines = [f"📊 **{total} result(s) found:**\n"]
        for i, row in enumerate(rows, 1):
            parts = [f"**{c.replace('_',' ').title()}:** {v if v is not None else '—'}" for c, v in row.items()]
            lines.append(f"{i}. " + " | ".join(parts))
        return "\n".join(lines)
    lines = [f"📊 **{total} results found.** Showing first 15:\n"]
    for i, row in enumerate(rows[:15], 1):
        parts = [f"**{c.replace('_',' ').title()}:** {v if v is not None else '—'}" for c, v in row.items()]
        lines.append(f"{i}. " + " | ".join(parts))
    lines.append(f"\n… and **{total - 15} more** rows.")
    return "\n".join(lines)