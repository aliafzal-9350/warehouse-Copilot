const API_BASE = "http://127.0.0.1:8000";
let pendingSlots = {};
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordTimeout = null;
const MAX_RECORDING_MS = 6000;
let inventoryCard = null;
const SESSION_ID = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

/* ══════════════════════════════════════════════════════════════════════
   MESSAGE RENDERING
   ══════════════════════════════════════════════════════════════════════ */

function addMessage(text, type = "system") {
  const chatLog = document.getElementById("chat-log");
  const msg = document.createElement("div");
  msg.className = `msg ${type}`;

  // Support multi-line with bullet points
  if (text.includes("\n")) {
    text.split("\n").forEach((line) => {
      const p = document.createElement("div");
      p.textContent = line;
      msg.appendChild(p);
    });
  } else {
    msg.textContent = text;
  }

  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msg;
}

function addStatusMessage(text) {
  if (!text) return;
  const type = text.startsWith("✅") ? "success"
             : text.startsWith("❌") ? "error"
             : text.startsWith("⚠️") ? "warning"
             : "assistant";
  return addMessage(text, type);
}

function showTypingIndicator() {
  const chatLog = document.getElementById("chat-log");
  const indicator = document.createElement("div");
  indicator.className = "msg assistant typing-indicator";
  indicator.id = "typingIndicator";
  indicator.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`;
  chatLog.appendChild(indicator);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

function setInputEnabled(enabled) {
  const input = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  if (enabled) input.focus();
}

/* ══════════════════════════════════════════════════════════════════════
   MODAL
   ══════════════════════════════════════════════════════════════════════ */

function showModal(show) {
  const modal = document.getElementById("modal");
  modal.style.display = show ? "flex" : "none";
  if (show) ensureAtLeastOneRow();
}

function clearModalFields() {
  document.getElementById("customer").value = "";
  document.getElementById("warehouse").value = "";
  document.getElementById("receiving_date").value = "";
  document.getElementById("reference_no").value = "";
  const body = document.getElementById("lineItemsBody");
  body.innerHTML = "";
  ensureAtLeastOneRow();
}

/* ══════════════════════════════════════════════════════════════════════
   API CALLS
   ══════════════════════════════════════════════════════════════════════ */

async function fetchInventory(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v) params.append(k, v);
  });

  const res = await fetch(`${API_BASE}/api/inventory?${params.toString()}`);
  if (!res.ok) throw new Error(`Inventory failed: ${res.status}`);
  return res.json();
}

async function updateLine(lineId, payload) {
  const res = await fetch(`${API_BASE}/receiving/lines/${lineId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Update line failed: ${res.status}`);
  return res.json();
}

async function updateHeader(headerId, payload) {
  const res = await fetch(`${API_BASE}/receiving/headers/${headerId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Update header failed: ${res.status}`);
  return res.json();
}

async function deleteLine(lineId) {
  const res = await fetch(`${API_BASE}/receiving/lines/${lineId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete line failed: ${res.status}`);
  return res.json();
}

async function fetchChatResponse(message) {
  const res = await fetch(`${API_BASE}/chat/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Chat respond failed: ${res.status}`);
  return res.json();
}

async function transcribeAudio(blob) {
  const formData = new FormData();
  formData.append("file", blob, "voice.webm");
  const res = await fetch(`${API_BASE}/chat/transcribe`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Transcribe failed: ${res.status}`);
  }
  return res.json();
}

/* ══════════════════════════════════════════════════════════════════════
   VOICE RECORDING
   ═════════════════════════════════════════════════════════��════════════ */

function setupVoiceRecording() {
  const micBtn = document.getElementById("micBtn");
  const statusEl = document.getElementById("voiceStatus");
  const userInput = document.getElementById("userInput");

  if (!navigator.mediaDevices?.getUserMedia) {
    statusEl.textContent = "Voice: not supported.";
    micBtn.disabled = true;
    micBtn.classList.add("disabled");
    return;
  }

  micBtn.addEventListener("click", async () => {
    if (isRecording) {
      mediaRecorder.stop();
      micBtn.classList.remove("listening");
      statusEl.textContent = "Voice: processing...";
      if (recordTimeout) clearTimeout(recordTimeout);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        try {
          const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
          const data = await transcribeAudio(audioBlob);
          userInput.value = data.text || "";
          statusEl.textContent = "Voice: captured. Click Send.";
        } catch (err) {
          console.error(err);
          statusEl.textContent = `Voice: error (${err.message})`;
        } finally {
          isRecording = false;
          micBtn.classList.remove("listening");
        }
      };

      isRecording = true;
      micBtn.classList.add("listening");
      statusEl.textContent = "Voice: recording (auto-stop in 6s)...";
      mediaRecorder.start();

      recordTimeout = setTimeout(() => {
        if (isRecording) {
          mediaRecorder.stop();
          micBtn.classList.remove("listening");
          statusEl.textContent = "Voice: processing...";
        }
      }, MAX_RECORDING_MS);
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Voice: permission denied.";
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════
   LINE ITEMS (MODAL)
   ══════════════════════════════════════════════════════════════════════ */

function createLineRow(values = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="text" class="line-item item_code" placeholder="ITEM-A" value="${values.item_code || ""}"></td>
    <td><input type="text" class="line-item location" placeholder="A1" value="${values.location || ""}"></td>
    <td><input type="text" class="line-item batch_no" placeholder="BATCH-01" value="${values.batch_no || ""}"></td>
    <td><input type="date" class="line-item mfg_date" value="${values.mfg_date || ""}"></td>
    <td><input type="date" class="line-item expiry_date" value="${values.expiry_date || ""}"></td>
    <td><input type="date" class="line-item shelf_expiry_date" value="${values.shelf_expiry_date || ""}"></td>
    <td><input type="number" class="line-item quantity" placeholder="50" value="${values.quantity || ""}"></td>
    <td>
      <select class="line-item status">
        <option value="">Select</option>
        <option value="ok" ${values.status === "ok" ? "selected" : ""}>OK</option>
        <option value="damaged" ${values.status === "damaged" ? "selected" : ""}>Damaged</option>
      </select>
    </td>
    <td class="line-actions">
      <button class="btn ghost remove-row" type="button">Remove</button>
    </td>
  `;
  return row;
}

function ensureAtLeastOneRow() {
  const body = document.getElementById("lineItemsBody");
  if (body.children.length === 0) {
    body.appendChild(createLineRow());
  }
}

function collectLineItems() {
  const body = document.getElementById("lineItemsBody");
  return Array.from(body.querySelectorAll("tr")).map((row) => ({
    item_code: row.querySelector(".item_code").value.trim(),
    location: row.querySelector(".location").value.trim(),
    batch_no: row.querySelector(".batch_no").value.trim(),
    manufacturing_date: row.querySelector(".mfg_date").value || null,
    expiry_date: row.querySelector(".expiry_date").value || null,
    shelf_expiry_date: row.querySelector(".shelf_expiry_date").value || null,
    quantity: Number(row.querySelector(".quantity").value),
    status: row.querySelector(".status").value,
  }));
}

/* ══════════════════════════════════════════════════════════════════════
   INVENTORY CARD (INLINE TABLE)
   ══════════════════════════════════════════════════════════════════════ */

function setRowEditing(row, isEditing) {
  row.classList.toggle("editing", isEditing);
  row.querySelectorAll(".view-text").forEach((el) => {
    el.style.display = isEditing ? "none" : "inline-block";
  });
  row.querySelectorAll("input, select").forEach((input) => {
    input.style.display = isEditing ? "block" : "none";
  });
}

function resolveQuery(slots) {
  return slots.query || slots.reference_no || slots.item_code || slots.batch_no || slots.customer;
}

async function findSingleRow(query) {
  const data = await fetchInventory({ q: query });
  if (!data.rows || !data.rows.length) {
    throw new Error(`No record found for "${query}".`);
  }
  if (data.rows.length > 1) {
    // Show all matches so user can pick
    await refreshInventory({ q: query });
    throw new Error(
      `Found ${data.rows.length} records for "${query}". Please be more specific or use the table above to edit/delete.`
    );
  }
  return data.rows[0];
}

/* ── Intent Handlers ────────────────────────────────────────────────── */

async function handleAdjustQuantity(slots) {
  const query = resolveQuery(slots);
  const quantity = slots.quantity;

  if (!query || !quantity) {
    addMessage("Please specify quantity and reference keyword.", "error");
    return;
  }

  try {
    const row = await findSingleRow(query);
    const newQty = (row.quantity || 0) + quantity;
    await updateLine(row.line_id, { quantity: newQty });
    await refreshInventory({ q: query });
    addStatusMessage(`✅ Successfully received ${quantity} more quantity in ${query}. New total: ${newQty}.`);
  } catch (err) {
    addMessage(`❌ ${err.message}`, "error");
  }
}

async function handleDeleteLine(slots) {
  const query = resolveQuery(slots);
  if (!query) {
    addMessage("❌ Please specify which record to delete.", "error");
    return;
  }

  try {
    const row = await findSingleRow(query);
    await deleteLine(row.line_id);
    await refreshInventory({});
    addStatusMessage(`✅ Successfully deleted line for '${query}'.`);
  } catch (err) {
    addMessage(`❌ ${err.message}`, "error");
  }
}

async function handleOpenRecord(slots) {
  const query = resolveQuery(slots);
  if (!query) {
    addMessage("❌ Please specify which record to open.", "error");
    return;
  }

  try {
    const rows = await refreshInventory({ q: query });
    if (rows && rows.length > 0) {
      const firstRow = document.querySelector("#inventoryBody tr");
      if (firstRow) {
        setRowEditing(firstRow, true);
        addStatusMessage(`✅ Record for '${query}' opened for editing. Make changes and click Save.`);
      }
    } else {
      addMessage(`❌ No record found for '${query}'.`, "error");
    }
  } catch (err) {
    addMessage(`❌ ${err.message}`, "error");
  }
}

/* ── Inventory Card Builder ─────────────────────────────────────────── */

function buildInventoryCard() {
  const chatLog = document.getElementById("chat-log");
  inventoryCard = document.createElement("div");
  inventoryCard.className = "msg assistant card";
  inventoryCard.innerHTML = `
    <div class="card-header">📦 Inventory Report</div>
    <div class="inventory-filters">
      <div class="filter-group">
        <input type="text" id="inv_q" placeholder="Search any keyword (POS-123, customer, item, batch...)" />
        <input type="text" id="inv_customer" placeholder="Customer" />
        <input type="text" id="inv_reference" placeholder="Reference No" />
        <input type="date" id="inv_date_from" />
        <input type="date" id="inv_date_to" />
        <button id="invSearchBtn" class="btn primary small">Search</button>
        <button id="invClearBtn" class="btn ghost small">Clear</button>
      </div>
    </div>
    <div class="inventory-table-wrapper">
      <table class="inventory-table">
        <thead>
          <tr>
            <th>Customer</th><th>Receiving Date</th><th>Reference No</th>
            <th>Warehouse</th><th>Item Code</th><th>Location</th>
            <th>Batch No</th><th>MFG Date</th><th>Expiry Date</th>
            <th>Shelf Expiry</th><th>Quantity</th><th>Status</th><th>Actions</th>
          </tr>
        </thead>
        <tbody id="inventoryBody"></tbody>
      </table>
    </div>
  `;
  chatLog.appendChild(inventoryCard);
  chatLog.scrollTop = chatLog.scrollHeight;

  inventoryCard.querySelector("#invSearchBtn").addEventListener("click", () => {
    refreshInventory(collectInventoryFilters());
  });

  inventoryCard.querySelector("#invClearBtn").addEventListener("click", () => {
    inventoryCard.querySelector("#inv_q").value = "";
    inventoryCard.querySelector("#inv_customer").value = "";
    inventoryCard.querySelector("#inv_reference").value = "";
    inventoryCard.querySelector("#inv_date_from").value = "";
    inventoryCard.querySelector("#inv_date_to").value = "";
    refreshInventory({});
  });

  // ── Delegated event handlers for Edit / Save / Delete ──
  inventoryCard.addEventListener("click", async (e) => {

    // ── EDIT ──
    if (e.target.closest(".row-edit")) {
      const row = e.target.closest("tr");
      setRowEditing(row, true);
    }

    // ── SAVE ──
    if (e.target.closest(".row-save")) {
      const row = e.target.closest("tr");
      const lineId = row.dataset.lineId;
      const headerId = row.dataset.headerId;

      const headerPayload = {
        customer: row.querySelector(".inline-customer").value.trim(),
        receiving_date: row.querySelector(".inline-receiving-date").value || null,
        reference_no: row.querySelector(".inline-reference").value.trim(),
        warehouse: row.querySelector(".inline-warehouse").value.trim(),
      };

      const linePayload = {
        item_code: row.querySelector(".inline-item_code").value.trim(),
        location: row.querySelector(".inline-location").value.trim(),
        batch_no: row.querySelector(".inline-batch").value.trim(),
        manufacturing_date: row.querySelector(".inline-mfg").value || null,
        expiry_date: row.querySelector(".inline-expiry").value || null,
        shelf_expiry_date: row.querySelector(".inline-shelf-expiry").value || null,
        quantity: Number(row.querySelector(".inline-qty").value) || null,
        status: row.querySelector(".inline-status").value,
      };

      // Validate required fields
      const missingHeader = ["customer", "receiving_date", "reference_no", "warehouse"]
        .filter((k) => !headerPayload[k]);
      const missingLine = ["item_code", "location", "status"]
        .filter((k) => !linePayload[k]);

      if (!linePayload.quantity || linePayload.quantity <= 0) missingLine.push("quantity");

      if (missingHeader.length || missingLine.length) {
        addMessage(`❌ Missing required fields: ${[...missingHeader, ...missingLine].join(", ")}`, "error");
        return;
      }

      try {
        await updateHeader(headerId, headerPayload);
        await updateLine(lineId, linePayload);
        setRowEditing(row, false);
        addStatusMessage(`✅ Record updated successfully.`);
        refreshInventory(collectInventoryFilters());
      } catch (err) {
        addMessage(`❌ ${err.message || "Failed to update row."}`, "error");
      }
    }

    // ── DELETE ──
    if (e.target.closest(".row-delete")) {
      const row = e.target.closest("tr");
      const lineId = row.dataset.lineId;
      const ref = row.querySelector(".inline-reference")?.value || lineId;

      if (!confirm(`Delete line item for '${ref}'?`)) return;

      try {
        await deleteLine(lineId);
        row.remove();
        addStatusMessage(`✅ Line '${ref}' deleted successfully.`);
      } catch (err) {
        addMessage(`❌ ${err.message || "Failed to delete line."}`, "error");
      }
    }
  });
}

function collectInventoryFilters() {
  return {
    q: inventoryCard.querySelector("#inv_q").value.trim(),
    customer: inventoryCard.querySelector("#inv_customer").value.trim(),
    reference_no: inventoryCard.querySelector("#inv_reference").value.trim(),
    date_from: inventoryCard.querySelector("#inv_date_from").value,
    date_to: inventoryCard.querySelector("#inv_date_to").value,
  };
}

async function refreshInventory(filters = {}) {
  if (!inventoryCard) buildInventoryCard();

  const tbody = inventoryCard.querySelector("#inventoryBody");
  tbody.innerHTML = `<tr><td colspan="13" class="loading-cell">Loading...</td></tr>`;

  try {
    const data = await fetchInventory(filters);
    const rows = data.rows || [];

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="13" class="empty-cell">No records found.</td></tr>`;
      return rows;
    }

    const cell = (value, inputClass, type = "text") => `
      <div class="cell-wrap">
        <span class="view-text">${value || "—"}</span>
        <input type="${type}" class="inline-input ${inputClass}" value="${value || ""}" />
      </div>
    `;

    tbody.innerHTML = rows
      .map(
        (r) => `
      <tr data-line-id="${r.line_id}" data-header-id="${r.header_id}">
        <td>${cell(r.customer, "inline-customer")}</td>
        <td>${cell(r.receiving_date, "inline-receiving-date", "date")}</td>
        <td>${cell(r.reference_no, "inline-reference")}</td>
        <td>${cell(r.warehouse, "inline-warehouse")}</td>
        <td>${cell(r.item_code, "inline-item_code")}</td>
        <td>${cell(r.location, "inline-location")}</td>
        <td>${cell(r.batch_no, "inline-batch")}</td>
        <td>${cell(r.manufacturing_date, "inline-mfg", "date")}</td>
        <td>${cell(r.expiry_date, "inline-expiry", "date")}</td>
        <td>${cell(r.shelf_expiry_date, "inline-shelf-expiry", "date")}</td>
        <td>${cell(r.quantity ?? "", "inline-qty", "number")}</td>
        <td>
          <div class="cell-wrap">
            <span class="view-text">${r.status || "—"}</span>
            <select class="inline-input inline-status">
              <option value="ok" ${r.status === "ok" ? "selected" : ""}>OK</option>
              <option value="damaged" ${r.status === "damaged" ? "selected" : ""}>Damaged</option>
            </select>
          </div>
        </td>
        <td class="action-cell">
          <button class="icon-btn edit row-edit" title="Edit">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
            </svg>
          </button>
          <button class="icon-btn save row-save" title="Save">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
              <polyline points="17 21 17 13 7 13 7 21"></polyline>
              <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
          </button>
          <button class="icon-btn danger row-delete" title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-2 14H7L5 6"></path>
              <path d="M10 11v6"></path><path d="M14 11v6"></path>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
            </svg>
          </button>
        </td>
      </tr>`
      )
      .join("");

    tbody.querySelectorAll("tr").forEach((row) => setRowEditing(row, false));

    // Scroll inventory card into view
    inventoryCard.scrollIntoView({ behavior: "smooth", block: "end" });

    return rows;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="13" class="error-cell">Failed to load inventory.</td></tr>`;
    return [];
  }
}

/* ══════════════════════════════════════════════════════════════════════
   WELCOME
   ══════════════════════════════════════════════════════════════════════ */

function showWelcomeMessage() {
  addMessage(
    "📦 Warehouse Copilot initialized.\n" +
    "Control everything from here — type naturally:\n" +
    "• \"receive stock\" — open receiving form\n" +
    "• \"add 10 qty in POS-123\" — adjust quantity\n" +
    "• \"delete POS-456\" — remove a line\n" +
    "• \"search customer Ali\" — find records\n" +
    "• \"check inventory\" — view all stock",
    "system"
  );
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN EVENT LOOP
   ══════════════════════════════════════════════════════════════════════ */

window.addEventListener("DOMContentLoaded", () => {
  const sendBtn = document.getElementById("sendBtn");
  const userInput = document.getElementById("userInput");
  const confirmBtn = document.getElementById("confirmBtn");
  const closeModal = document.getElementById("closeModal");
  const addLineBtn = document.getElementById("addLineBtn");
  const lineItemsBody = document.getElementById("lineItemsBody");

  if (!confirmBtn || !closeModal) {
    console.error("Modal buttons not found. Check index.html modal block.");
    return;
  }

  showWelcomeMessage();
  setupVoiceRecording();

  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // ── Quick-action chips ──
  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "receive") {
        showModal(true);
      } else if (action === "inventory") {
        refreshInventory({});
      } else if (action === "reports") {
        userInput.value = "Show receiving report";
        sendBtn.click();
      }
    });
  });

  // ── Add / Remove line rows ──
  addLineBtn.addEventListener("click", () => lineItemsBody.appendChild(createLineRow()));
  lineItemsBody.addEventListener("click", (e) => {
    if (e.target.classList.contains("remove-row")) {
      e.target.closest("tr").remove();
      ensureAtLeastOneRow();
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SEND BUTTON — the main command dispatcher
  // ═══════════════════════════════════════════════════════════
  sendBtn.addEventListener("click", async () => {
    const message = userInput.value.trim();
    if (!message) return;

    addMessage(message, "user");
    userInput.value = "";
    setInputEnabled(false);
    showTypingIndicator();

    try {
      const res = await fetch(`${API_BASE}/chat/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, session_id: SESSION_ID }),
      });

      if (!res.ok) throw new Error(`Interpret failed: ${res.status}`);
      const data = await res.json();

      removeTypingIndicator();

      pendingSlots = data.slots || {};
      const intent = data.intent || "unknown";
      const action = data.action || "chat_reply";

      // ── Show status from backend ──
      if (data.status && action !== "chat_reply") {
        addStatusMessage(data.status);
      }

      // ── Route by action type ──
      if (action === "request_info") {
        // Already displayed status — waiting for user input
        return;
      }

      if (action === "open_receive_form" || intent === "receive_stock") {
        showModal(true);
        return;
      }

      if (action === "show_inventory" || intent === "check_inventory" || intent === "report") {
        await refreshInventory({});
        return;
      }

      if (action === "open_record" || intent === "open_record") {
        await handleOpenRecord(pendingSlots);
        return;
      }

      if (action === "adjust_quantity" || intent === "adjust_quantity") {
        await handleAdjustQuantity(pendingSlots);
        return;
      }

      if (action === "confirm_delete" || intent === "delete_line") {
        // Confirmation prompt already shown — wait for "yes"
        return;
      }

      if (action === "execute_delete" && data.confirmed) {
        await handleDeleteLine(pendingSlots);
        return;
      }

      if (action === "delete_cancelled") {
        // Already displayed status
        return;
      }

      // ── Fallback: general chat ──
      if (data.response) {
        addMessage(data.response, "assistant");
      } else {
        const chat = await fetchChatResponse(message);
        addMessage(chat.reply, "assistant");
      }
    } catch (err) {
      removeTypingIndicator();
      console.error(err);
      addMessage(`❌ ${err.message || "Error processing command. Please try again."}`, "error");
    } finally {
      setInputEnabled(true);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CONFIRM RECEIVING — auto-close on success
  // ═══════════════════════════════════════════════════════════
  confirmBtn.addEventListener("click", async () => {
    const payload = {
      customer: document.getElementById("customer").value.trim(),
      warehouse: document.getElementById("warehouse").value.trim(),
      receiving_date: document.getElementById("receiving_date").value,
      reference_no: document.getElementById("reference_no").value.trim(),
      items: collectLineItems(),
    };

    const missingHeader = ["customer", "warehouse", "receiving_date", "reference_no"]
      .filter((key) => !payload[key]);

    if (missingHeader.length) {
      addMessage(`❌ Missing required fields: ${missingHeader.join(", ")}`, "error");
      return;
    }

    // Validate line items
    const invalidLines = payload.items.filter(
      (item) => !item.item_code || !item.quantity || item.quantity <= 0 || !item.status
    );
    if (invalidLines.length) {
      addMessage("❌ Each line must have Item Code, Quantity (> 0), and Status.", "error");
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.textContent = "Saving...";

    try {
      const res = await fetch(`${API_BASE}/receiving/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Confirm failed: ${res.status}`);
      }

      await res.json();

      // ✅ AUTO-CLOSE form + dynamic success message
      showModal(false);
      clearModalFields();

      const totalQty = payload.items.reduce((sum, i) => sum + (i.quantity || 0), 0);
      const itemCodes = [...new Set(payload.items.map((i) => i.item_code))].join(", ");

      addStatusMessage(
        `✅ Successfully received ${totalQty} units of ${itemCodes} ` +
        `into ${payload.warehouse} (Ref: ${payload.reference_no}).`
      );
    } catch (err) {
      console.error(err);
      addMessage(`❌ ${err.message || "Error saving receiving."}`, "error");
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm";
    }
  });

  closeModal.addEventListener("click", () => showModal(false));
});