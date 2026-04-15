/* ============================================================
   Warehouse Copilot – app.js
   Single-window architecture: all operations use #workspacePanel.
   Intent understanding passes through /chat/interpret (Gemini NLP).
   NOW WITH: query_data intent for natural language data questions.
   NOW WITH: "edit PO-xx" → editable rows + "Add Item Line" button.
   ============================================================ */

const API_BASE = "http://127.0.0.1:8000";
let pendingSlots = {};
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordTimeout = null;
const MAX_RECORDING_MS = 6000;
const SESSION_ID = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

/* ===========================================================================
   Safe JSON helpers
   =========================================================================== */

async function safeParseJsonResponse(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchWithJson(url, options = {}) {
  const res = await fetch(url, options);
  const parsed = await safeParseJsonResponse(res);
  if (!res.ok) {
    const errMsg = (parsed && (parsed.detail || parsed.error || parsed.message)) || `Request failed: ${res.status}`;
    throw new Error(errMsg);
  }
  return parsed;
}

/* ===========================================================================
   Chat / UI helpers
   =========================================================================== */

function addMessage(text, type = "system") {
  const chatLog = document.getElementById("chat-log");
  const msg = document.createElement("div");
  msg.className = `msg ${type}`;

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

/** Add a rich HTML message (used for query results with bold formatting) */
function addRichMessage(html, type = "assistant") {
  const chatLog = document.getElementById("chat-log");
  const msg = document.createElement("div");
  msg.className = `msg ${type}`;
  msg.innerHTML = html;
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

/* ===========================================================================
   Workspace Panel
   =========================================================================== */

const WORKSPACE_TITLES = {
  receive: "📥 Receive Stock",
  inventory: "📦 Inventory",
  report: "📊 Reports",
};

function showWorkspace(section) {
  const panel = document.getElementById("workspacePanel");
  const app = document.querySelector(".app");
  panel.querySelectorAll(".workspace-section").forEach(s => s.classList.remove("active"));
  const target = panel.querySelector(`#ws-${section}`);
  if (target) target.classList.add("active");
  document.getElementById("workspaceTitle").textContent =
    WORKSPACE_TITLES[section] || "Workspace";
  panel.classList.remove("hidden");
  app.classList.add("workspace-open");
}

function hideWorkspace() {
  const panel = document.getElementById("workspacePanel");
  const app = document.querySelector(".app");
  panel.classList.add("hidden");
  app.classList.remove("workspace-open");
  // Clean up any add-line bars when closing workspace
  document.querySelectorAll(".inv-add-line-bar").forEach(el => el.remove());
}

/* ===========================================================================
   Receive form helpers
   =========================================================================== */

function createLineRow(values = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="text"   class="line-item item_code"          placeholder="ITEM-A"   value="${values.item_code || ""}"></td>
    <td><input type="text"   class="line-item location"           placeholder="A1"       value="${values.location || ""}"></td>
    <td><input type="text"   class="line-item batch_no"           placeholder="BATCH-01" value="${values.batch_no || ""}"></td>
    <td><input type="date"   class="line-item mfg_date"           value="${values.mfg_date || ""}"></td>
    <td><input type="date"   class="line-item expiry_date"        value="${values.expiry_date || ""}"></td>
    <td><input type="date"   class="line-item shelf_expiry_date"  value="${values.shelf_expiry_date || ""}"></td>
    <td><input type="number" class="line-item quantity"           placeholder="50"       value="${values.quantity || ""}"></td>
    <td>
      <select class="line-item status">
        <option value="">Select</option>
        <option value="ok"      ${values.status === "ok" ? "selected" : ""}>OK</option>
        <option value="damaged" ${values.status === "damaged" ? "selected" : ""}>Damaged</option>
      </select>
    </td>
    <td><button class="remove-row" type="button">✕</button></td>
  `;
  return row;
}

function ensureAtLeastOneRow() {
  const body = document.getElementById("lineItemsBody");
  if (body && body.children.length === 0) {
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

function clearReceiveForm() {
  document.getElementById("customer").value = "";
  document.getElementById("warehouse").value = "";
  document.getElementById("receiving_date").value = "";
  document.getElementById("reference_no").value = "";
  const body = document.getElementById("lineItemsBody");
  if (body) { body.innerHTML = ""; ensureAtLeastOneRow(); }
}

/* ===========================================================================
   API calls
   =========================================================================== */

async function fetchInventory(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v) params.append(k, v); });
  params.append("_t", Date.now());
  const res = await fetch(`${API_BASE}/api/inventory?${params.toString()}`);
  if (!res.ok) throw new Error(`Inventory failed: ${res.status}`);
  return res.json();
}

async function updateLine(lineId, payload) {
  return fetchWithJson(`${API_BASE}/receiving/lines/${lineId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function updateHeader(headerId, payload) {
  return fetchWithJson(`${API_BASE}/receiving/headers/${headerId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function deleteLine(lineId) {
  return fetchWithJson(`${API_BASE}/receiving/lines/${lineId}`, { method: "DELETE" });
}

async function deleteHeaderByRef(reference) {
  return fetchWithJson(
    `${API_BASE}/receiving/headers/by-ref/${encodeURIComponent(reference)}`,
    { method: "DELETE" }
  );
}

async function handleDeleteLine(slots) {
  const query = (
    slots.reference_no ||
    slots.query ||
    slots.batch_no ||
    slots.customer ||
    slots.item_code
  );

  if (!query) {
    addStatusMessage("❌ Could not determine which record to delete. Please specify a reference number.");
    return;
  }

  try {
    addStatusMessage(`🗑️ Deleting '${query}'…`);
    const isReference = /[A-Za-z][\-\s]?\d|^PO|^GRN|^REF|^INV|^REC|^DO|^SO/i.test(query);

    if (isReference) {
      await deleteHeaderByRef(query);
    } else {
      const inv = await fetchInventory({ q: query });
      const rows = inv?.rows || [];
      if (rows.length === 0) {
        addStatusMessage(`❌ No record found matching '${query}'.`);
        return;
      }
      const headerIds = [...new Set(rows.map(r => r.header_id))];
      for (const hid of headerIds) {
        const lines = rows.filter(r => r.header_id === hid);
        for (const line of lines) {
          await deleteLine(line.line_id);
        }
      }
    }

    addStatusMessage(`✅ '${query}' deleted successfully.`);
    await refreshInventory({});

  } catch (err) {
    addStatusMessage(`❌ Delete failed: ${err.message}`);
  }
}

async function transcribeAudio(blob) {
  const formData = new FormData();
  formData.append("file", blob, "voice.webm");
  const res = await fetch(`${API_BASE}/chat/transcribe`, { method: "POST", body: formData });
  if (!res.ok) {
    const err = await safeParseJsonResponse(res).catch(() => ({}));
    throw new Error(err?.detail || `Transcribe failed: ${res.status}`);
  }
  return safeParseJsonResponse(res);
}

async function fetchChatResponse(message) {
  return fetchWithJson(`${API_BASE}/chat/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

/* ===========================================================================
   NEW: Query Data Handler — calls /chat/query for natural language questions
   =========================================================================== */

async function handleQueryData(originalMessage) {
  try {
    const res = await fetch(`${API_BASE}/chat/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: originalMessage }),
    });

    if (!res.ok) throw new Error(`Query failed: ${res.status}`);
    const data = await res.json();

    if (data.answer) {
      // Convert **bold** markdown to <strong> for rich rendering
      const richHtml = data.answer
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
      addRichMessage(richHtml, "assistant");
    } else {
      addMessage("📭 No results found for your question.", "assistant");
    }

    // If we have tabular data with many rows, also show a compact table
    if (data.rows && data.rows.length > 0 && data.columns && data.columns.length > 1) {
      renderQueryResultsTable(data.columns, data.rows);
    }

  } catch (err) {
    addMessage(`❌ ${err.message}`, "error");
  }
}

/** Render query results as a compact HTML table in the chat */
function renderQueryResultsTable(columns, rows) {
  if (!rows.length || !columns.length) return;

  const maxShow = Math.min(rows.length, 30);
  const chatLog = document.getElementById("chat-log");
  const wrapper = document.createElement("div");
  wrapper.className = "msg assistant query-table-wrapper";
  wrapper.style.cssText = "overflow-x:auto; max-width:100%; padding:8px;";

  let html = `<table style="border-collapse:collapse; width:100%; font-size:0.82em;">`;
  html += `<thead><tr>`;
  for (const col of columns) {
    const label = col.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    html += `<th style="border:1px solid #444; padding:4px 8px; background:#1e293b; color:#e2e8f0; text-align:left; white-space:nowrap;">${label}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (let i = 0; i < maxShow; i++) {
    const row = rows[i];
    html += `<tr>`;
    for (const col of columns) {
      const val = row[col] !== null && row[col] !== undefined ? row[col] : "—";
      html += `<td style="border:1px solid #333; padding:3px 8px; white-space:nowrap;">${val}</td>`;
    }
    html += `</tr>`;
  }

  html += `</tbody></table>`;
  if (rows.length > maxShow) {
    html += `<div style="color:#94a3b8; font-size:0.85em; margin-top:4px;">Showing ${maxShow} of ${rows.length} rows.</div>`;
  }

  wrapper.innerHTML = html;
  chatLog.appendChild(wrapper);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* ===========================================================================
   Voice recording
   =========================================================================== */

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
          userInput.value = data?.text || "";
          statusEl.textContent = "Voice: captured. Click Send.";
        } catch (err) {
          statusEl.textContent = `Voice: error (${err.message})`;
        } finally {
          isRecording = false;
          micBtn.classList.remove("listening");
        }
      };

      isRecording = true;
      micBtn.classList.add("listening");
      statusEl.textContent = "Voice: recording (auto-stop 6s)...";
      mediaRecorder.start();

      recordTimeout = setTimeout(() => {
        if (isRecording) {
          mediaRecorder.stop();
          micBtn.classList.remove("listening");
          statusEl.textContent = "Voice: processing...";
        }
      }, MAX_RECORDING_MS);
    } catch (err) {
      statusEl.textContent = "Voice: permission denied.";
    }
  });
}

/* ===========================================================================
   Inventory table
   =========================================================================== */

function collectInventoryFilters() {
  return {
    q: document.getElementById("inv_q")?.value.trim() || "",
    customer: document.getElementById("inv_customer")?.value.trim() || "",
    reference_no: document.getElementById("inv_reference")?.value.trim() || "",
    date_from: document.getElementById("inv_date_from")?.value || "",
    date_to: document.getElementById("inv_date_to")?.value || "",
  };
}

function setRowEditing(row, isEditing) {
  row.classList.toggle("editing", isEditing);
  row.querySelectorAll(".view-text").forEach(el => (el.style.display = isEditing ? "none" : "inline-block"));
  row.querySelectorAll("input, select").forEach(input => (input.style.display = isEditing ? "block" : "none"));
}

async function refreshInventory(filters = {}) {
  showWorkspace("inventory");
  // Clean up any old add-line bars
  document.querySelectorAll(".inv-add-line-bar").forEach(el => el.remove());

  const tbody = document.getElementById("inventoryBody");
  tbody.innerHTML = `<tr><td colspan="13" class="loading-cell">Loading…</td></tr>`;

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

    tbody.innerHTML = rows.map((r) => `
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
              <option value="ok"      ${r.status === "ok" ? "selected" : ""}>OK</option>
              <option value="damaged" ${r.status === "damaged" ? "selected" : ""}>Damaged</option>
            </select>
          </div>
        </td>
        <td class="action-cell">
          <button class="icon-btn edit  row-edit"   title="Edit">✎</button>
          <button class="icon-btn save  row-save"   title="Save">💾</button>
          <button class="icon-btn danger row-delete" title="Delete">🗑</button>
        </td>
      </tr>`
    ).join("");

    tbody.querySelectorAll("tr").forEach(row => setRowEditing(row, false));
    return rows;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="13" class="error-cell">Failed to load inventory.</td></tr>`;
    return [];
  }
}

function wireInventoryActions() {
  const tbody = document.getElementById("inventoryBody");
  if (!tbody) return;

  tbody.addEventListener("click", async (e) => {
    const row = e.target.closest("tr");
    if (!row) return;

    if (e.target.closest(".row-edit")) {
      setRowEditing(row, true);
      return;
    }

    if (e.target.closest(".row-save")) {
      const lineId = row.dataset.lineId;
      const headerId = row.dataset.headerId;

      const headerPayload = {
        customer: row.querySelector(".inline-customer")?.value.trim(),
        receiving_date: row.querySelector(".inline-receiving-date")?.value || null,
        reference_no: row.querySelector(".inline-reference")?.value.trim(),
        warehouse: row.querySelector(".inline-warehouse")?.value.trim(),
      };
      const linePayload = {
        item_code: row.querySelector(".inline-item_code")?.value.trim(),
        location: row.querySelector(".inline-location")?.value.trim(),
        batch_no: row.querySelector(".inline-batch")?.value.trim(),
        manufacturing_date: row.querySelector(".inline-mfg")?.value || null,
        expiry_date: row.querySelector(".inline-expiry")?.value || null,
        shelf_expiry_date: row.querySelector(".inline-shelf-expiry")?.value || null,
        quantity: Number(row.querySelector(".inline-qty")?.value) || null,
        status: row.querySelector(".inline-status")?.value,
      };

      const missingHeader = ["customer", "receiving_date", "reference_no", "warehouse"].filter(k => !headerPayload[k]);
      const missingLine = ["item_code", "location", "status"].filter(k => !linePayload[k]);
      if (!linePayload.quantity || linePayload.quantity <= 0) missingLine.push("quantity");

      if (missingHeader.length || missingLine.length) {
        addMessage(`❌ Missing required fields: ${[...missingHeader, ...missingLine].join(", ")}`, "error");
        return;
      }

      try {
        await updateHeader(headerId, headerPayload);
        await updateLine(lineId, linePayload);
        setRowEditing(row, false);
        addStatusMessage("✅ Record updated successfully.");
        refreshInventory(collectInventoryFilters());
      } catch (err) {
        addMessage(`❌ ${err.message || "Failed to update row."}`, "error");
      }
      return;
    }

    if (e.target.closest(".row-delete")) {
      const lineId = row.dataset.lineId;
      const ref = row.querySelector(".inline-reference")?.value || lineId;
      if (!confirm(`Delete line item for '${ref}'?`)) return;
      try {
        await deleteLine(lineId);
        row.remove();
        addStatusMessage(`✅ Line '${ref}' deleted.`);
      } catch (err) {
        addMessage(`❌ ${err.message || "Failed to delete."}`, "error");
      }
    }
  });
}

/* ===========================================================================
   Intent action handlers
   =========================================================================== */

function resolveQuery(slots) {
  return slots.query || slots.reference_no || slots.item_code || slots.batch_no || slots.customer;
}

async function findSingleRow(query) {
  const data = await fetchInventory({ q: query });
  if (!data.rows || !data.rows.length) throw new Error(`No record found for "${query}".`);
  if (data.rows.length > 1) {
    await refreshInventory({ q: query });
    throw new Error(`Found ${data.rows.length} records for "${query}". Use the inventory table to select.`);
  }
  return data.rows[0];
}

async function handleAdjustQuantity(slots) {
  const query = resolveQuery(slots);
  const quantity = slots.quantity;
  if (!query || !quantity) {
    addMessage("Please specify quantity and a reference keyword.", "error");
    return;
  }
  try {
    const row = await findSingleRow(query);
    const newQty = (row.quantity || 0) + quantity;
    await updateLine(row.line_id, { quantity: newQty });
    await refreshInventory({ q: query });
    addStatusMessage(`✅ Added ${quantity} units to '${query}'. New total: ${newQty}.`);
  } catch (err) {
    addMessage(`❌ ${err.message}`, "error");
  }
}

async function handleDeleteLineFromSlots(slots) {
  const query = resolveQuery(slots);
  if (!query) { addMessage("❌ Please specify which record to delete.", "error"); return; }

  const looksLikeReference = /[A-Za-z\-_]/.test(query) && isNaN(Number(query));
  try {
    if (looksLikeReference) {
      await deleteHeaderByRef(query);
      addStatusMessage(`✅ '${query}' deleted successfully.`);
      await refreshInventory({});
      return;
    }
    const row = await findSingleRow(query);
    await deleteLine(row.line_id);
    addStatusMessage(`✅ Line for '${query}' deleted.`);
    await refreshInventory({});
  } catch (err) {
    addMessage(`❌ ${err.message}`, "error");
  }
}

async function handleOpenRecord(slots) {
  const query = resolveQuery(slots);
  if (!query) {
    addMessage("Please specify a customer, reference number, batch, or item code to search.", "assistant");
    return;
  }

  const rows = await refreshInventory({ q: query });

  // Check the last user message in chat to see if it was an edit intent
  const chatMsgs = document.querySelectorAll("#chat-log .msg.user");
  let userText = "";
  if (chatMsgs.length) {
    userText = chatMsgs[chatMsgs.length - 1]?.textContent?.toLowerCase() || "";
  }
  const wantsEdit = /\b(edit|modify|change|update)\b/.test(userText);

  setTimeout(() => {
    const tbody = document.getElementById("inventoryBody");
    if (!tbody) return;
    const tableRows = tbody.querySelectorAll("tr[data-line-id]");

    if (wantsEdit && tableRows.length > 0) {
      // Put all matching rows in edit mode
      tableRows.forEach(row => setRowEditing(row, true));

      // Detect if this is a reference-based search (PO-xx, GRN-xx etc.)
      const isRef = /^[A-Za-z]+[\-\s]?\d+$/.test(query.trim());
      const headerId = tableRows[0]?.dataset?.headerId;

      if (isRef && headerId) {
        // Show the "Add Item Line" button below the table
        showAddLineButton(headerId, query);
      }
    }
  }, 150);
}

/* ===========================================================================
   ADD LINE TO EXISTING HEADER — "edit PO-01" → edits + can add new items
   =========================================================================== */

function showAddLineButton(headerId, refNo) {
  // Remove any existing add-line buttons first
  document.querySelectorAll(".inv-add-line-bar").forEach(el => el.remove());

  const wsInventory = document.getElementById("ws-inventory");
  if (!wsInventory) return;

  const bar = document.createElement("div");
  bar.className = "inv-add-line-bar";
  bar.innerHTML = `
    <button class="btn primary small inv-add-line-btn" data-header-id="${headerId}" data-ref="${refNo}">
      + Add Item Line to ${refNo}
    </button>
  `;

  // Insert after the inventory table wrapper
  const tableWrapper = wsInventory.querySelector(".inventory-table-wrapper");
  if (tableWrapper) {
    tableWrapper.after(bar);
  } else {
    wsInventory.appendChild(bar);
  }

  bar.querySelector(".inv-add-line-btn").addEventListener("click", () => {
    renderAddLineRow(headerId, refNo);
  });
}

function renderAddLineRow(headerId, refNo) {
  const tbody = document.getElementById("inventoryBody");
  if (!tbody) return;

  // Check if there's already a new-line row being added
  const existing = tbody.querySelector("tr.new-line-row");
  if (existing) {
    existing.querySelector(".new-item_code")?.focus();
    return;
  }

  // Get the header info from the first existing row (to pre-fill customer, date, warehouse)
  const firstRow = tbody.querySelector("tr[data-header-id]");
  const preCustomer = firstRow?.querySelector(".inline-customer")?.value ||
                      firstRow?.querySelector(".view-text")?.textContent || "";
  const preDate     = firstRow?.querySelector(".inline-receiving-date")?.value || "";
  const preWH       = firstRow?.querySelector(".inline-warehouse")?.value ||
                      firstRow?.querySelectorAll(".view-text")[3]?.textContent || "";

  const newRow = document.createElement("tr");
  newRow.className = "new-line-row editing";
  newRow.dataset.headerId = headerId;

  newRow.innerHTML = `
    <td><div class="cell-wrap"><input type="text"   class="inline-input inline-customer"        value="${preCustomer}" disabled style="display:block; opacity:0.5;" /></div></td>
    <td><div class="cell-wrap"><input type="date"   class="inline-input inline-receiving-date"   value="${preDate}" disabled style="display:block; opacity:0.5;" /></div></td>
    <td><div class="cell-wrap"><input type="text"   class="inline-input inline-reference"        value="${refNo}" disabled style="display:block; opacity:0.5;" /></div></td>
    <td><div class="cell-wrap"><input type="text"   class="inline-input inline-warehouse"        value="${preWH}" disabled style="display:block; opacity:0.5;" /></div></td>
    <td><div class="cell-wrap"><input type="text"   class="inline-input new-item_code"           placeholder="Item Code" style="display:block;" /></div></td>
    <td><div class="cell-wrap"><input type="text"   class="inline-input new-location"            placeholder="A1" style="display:block;" /></div></td>
    <td><div class="cell-wrap"><input type="text"   class="inline-input new-batch"               placeholder="BATCH-XX" style="display:block;" /></div></td>
    <td><div class="cell-wrap"><input type="date"   class="inline-input new-mfg"                 style="display:block;" /></div></td>
    <td><div class="cell-wrap"><input type="date"   class="inline-input new-expiry"              style="display:block;" /></div></td>
    <td><div class="cell-wrap"><input type="date"   class="inline-input new-shelf-expiry"        style="display:block;" /></div></td>
    <td><div class="cell-wrap"><input type="number" class="inline-input new-qty"                 placeholder="50" style="display:block;" /></div></td>
    <td>
      <div class="cell-wrap">
        <select class="inline-input new-status" style="display:block;">
          <option value="ok" selected>OK</option>
          <option value="damaged">Damaged</option>
        </select>
      </div>
    </td>
    <td class="action-cell">
      <button class="icon-btn save  new-line-save"   title="Save New Line">💾</button>
      <button class="icon-btn danger new-line-cancel" title="Cancel">✕</button>
    </td>
  `;

  tbody.appendChild(newRow);

  // Scroll to the new row
  newRow.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Focus the item code field
  setTimeout(() => {
    newRow.querySelector(".new-item_code")?.focus();
  }, 100);

  // Wire cancel
  newRow.querySelector(".new-line-cancel").addEventListener("click", () => {
    newRow.remove();
  });

  // Wire save
  newRow.querySelector(".new-line-save").addEventListener("click", async () => {
    await saveNewLine(newRow, headerId, refNo);
  });
}

async function saveNewLine(newRow, headerId, refNo) {
  const item_code   = newRow.querySelector(".new-item_code")?.value.trim();
  const location    = newRow.querySelector(".new-location")?.value.trim();
  const batch_no    = newRow.querySelector(".new-batch")?.value.trim() || null;
  const mfg         = newRow.querySelector(".new-mfg")?.value || null;
  const expiry      = newRow.querySelector(".new-expiry")?.value || null;
  const shelfExpiry = newRow.querySelector(".new-shelf-expiry")?.value || null;
  const quantity    = Number(newRow.querySelector(".new-qty")?.value);
  const status      = newRow.querySelector(".new-status")?.value;

  // Validate
  const missing = [];
  if (!item_code)                  missing.push("Item Code");
  if (!location)                   missing.push("Location");
  if (!quantity || quantity <= 0)   missing.push("Quantity (> 0)");
  if (!status)                     missing.push("Status");

  if (missing.length) {
    addMessage(`❌ New line missing: ${missing.join(", ")}`, "error");
    if (!item_code)        newRow.querySelector(".new-item_code")?.focus();
    else if (!location)    newRow.querySelector(".new-location")?.focus();
    else if (!quantity)    newRow.querySelector(".new-qty")?.focus();
    return;
  }

  // Disable save while posting
  const saveBtn = newRow.querySelector(".new-line-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "⏳";

  try {
    const res = await fetch(`${API_BASE}/receiving/lines/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        header_id: Number(headerId),
        item_code,
        location,
        quantity,
        status,
        batch_no,
        manufacturing_date: mfg,
        expiry_date: expiry,
        shelf_expiry_date: shelfExpiry,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `Failed: ${res.status}`);
    }

    const data = await res.json();
    addStatusMessage(`✅ New line added to ${refNo}: ${quantity} × ${item_code} (Line #${data.line_id})`);

    // Refresh the inventory view for the same reference
    newRow.remove();
    await refreshInventory({ q: refNo });

    // Re-show the add button and put rows back in edit mode
    setTimeout(() => {
      const tbody = document.getElementById("inventoryBody");
      if (!tbody) return;
      const tableRows = tbody.querySelectorAll("tr[data-line-id]");
      tableRows.forEach(row => setRowEditing(row, true));
      showAddLineButton(headerId, refNo);
    }, 200);

  } catch (err) {
    addMessage(`❌ Add line failed: ${err.message}`, "error");
    saveBtn.disabled = false;
    saveBtn.textContent = "💾";
  }
}

/* ===========================================================================
   Welcome message
   =========================================================================== */

function showWelcomeMessage() {
  addMessage(
    "📦 Warehouse Copilot ready.\n" +
    "How can I help you today?\n" +
    "Try asking: \"Total stock in every warehouse\" or \"List all damaged items\"",
    "system"
  );
}

/* ===========================================================================
   Main DOMContentLoaded
   =========================================================================== */

window.addEventListener("DOMContentLoaded", () => {
  const sendBtn = document.getElementById("sendBtn");
  const userInput = document.getElementById("userInput");
  const confirmBtn = document.getElementById("confirmBtn");
  const closeModal = document.getElementById("closeModal");
  const addLineBtn = document.getElementById("addLineBtn");
  const lineItemsBody = document.getElementById("lineItemsBody");
  const workspaceClose = document.getElementById("workspaceClose");

  if (!confirmBtn || !closeModal) {
    console.error("Workspace buttons not found. Check index.html.");
    return;
  }

  showWelcomeMessage();
  setupVoiceRecording();
  ensureAtLeastOneRow();
  wireInventoryActions();

  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendBtn.click(); }
  });

  workspaceClose.addEventListener("click", hideWorkspace);

  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "receive") {
        showWorkspace("receive");
        ensureAtLeastOneRow();
      } else if (action === "inventory") {
        refreshInventory({});
      } else if (action === "reports") {
        showWorkspace("report");
      }
    });
  });

  document.getElementById("invSearchBtn").addEventListener("click", () => {
    refreshInventory(collectInventoryFilters());
  });

  document.getElementById("invClearBtn").addEventListener("click", () => {
    ["inv_q", "inv_customer", "inv_reference", "inv_date_from", "inv_date_to"]
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    refreshInventory({});
  });

  addLineBtn.addEventListener("click", () => lineItemsBody.appendChild(createLineRow()));
  lineItemsBody.addEventListener("click", (e) => {
    if (e.target.classList.contains("remove-row")) {
      e.target.closest("tr").remove();
      ensureAtLeastOneRow();
    }
  });

  document.getElementById("loadReportBtn")?.addEventListener("click", () => {
    refreshInventory({});
  });

  closeModal.addEventListener("click", () => hideWorkspace());

  confirmBtn.addEventListener("click", async () => {
    const payload = {
      customer: document.getElementById("customer").value.trim(),
      warehouse: document.getElementById("warehouse").value.trim(),
      receiving_date: document.getElementById("receiving_date").value,
      reference_no: document.getElementById("reference_no").value.trim(),
      items: collectLineItems(),
    };

    const missingHeader = ["customer", "warehouse", "receiving_date", "reference_no"].filter(k => !payload[k]);
    if (missingHeader.length) {
      addMessage(`❌ Missing required header fields: ${missingHeader.join(", ")}`, "error");
      return;
    }

    const invalidLines = payload.items.filter(
      item => !item.item_code || !item.quantity || item.quantity <= 0 || !item.status
    );
    if (invalidLines.length) {
      addMessage("❌ Each line needs Item Code, Quantity (> 0), and Status.", "error");
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.textContent = "Saving…";

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

      await res.json().catch(() => ({}));
      hideWorkspace();
      clearReceiveForm();

      const totalQty = payload.items.reduce((sum, i) => sum + (i.quantity || 0), 0);
      const itemCodes = [...new Set(payload.items.map(i => i.item_code))].join(", ");

      addStatusMessage(
        `✅ Received ${totalQty} units of ${itemCodes} into ${payload.warehouse} (Ref: ${payload.reference_no}).`
      );
    } catch (err) {
      addMessage(`❌ ${err.message || "Error saving receiving."}`, "error");
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "✓ Confirm Receive";
    }
  });

  /* ══════════════════════════════════════════════════════════════════════
     Main send button — NLP intent dispatcher (WITH query_data support)
     ══════════════════════════════════════════════════════════════════════ */
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

      if (data.status && action !== "chat_reply") {
        addStatusMessage(data.status);
      }

      if (action === "request_info") {
        return;
      }

      // ── NEW: Query Data — natural language data questions ──────────
      if (action === "query_data" || intent === "query_data") {
        await handleQueryData(message);
        return;
      }

      // ── SMART RECEIVE: Show interactive card for review/confirmation ──
      if (action === "smart_receive" || intent === "smart_receive") {
        renderActionCard('smart_receive', data.slots || {}, data.status || "📥 Smart Receive — review the details below and confirm.");
        return;
      }

      if (action === "open_receive_form" || intent === "receive_stock") {
        showWorkspace("receive");
        ensureAtLeastOneRow();
        return;
      }

      if (action === "show_inventory" || intent === "check_inventory") {
        await refreshInventory({});
        return;
      }

      if (action === "show_report" || intent === "report") {
        showWorkspace("report");
        addStatusMessage("📊 Report workspace opened. Click 'Load Full Report' to view data.");
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

      if (action === "execute_delete" && data.confirmed) {
        await handleDeleteLine(pendingSlots);
        return;
      }

      if (action === "delete_cancelled") {
        return;
      }

      if (action === "confirm_delete") {
        return;
      }

      // ── Fallback: generic chat reply ────────────────────────────────
      if (data.response) {
        addMessage(data.response, "assistant");
      } else {
        const chat = await fetchChatResponse(message);
        addMessage(chat?.reply || "I can help with receiving stock, checking inventory, editing, deleting, reports, and data questions.", "assistant");
      }

    } catch (err) {
      removeTypingIndicator();
      console.error(err);
      addMessage(`❌ ${err.message || "Error processing command."}`, "error");
    } finally {
      setInputEnabled(true);
    }
  });

  // ── Generic Action Card Renderer (Professional, Extensible) ─────────────
  function renderActionCard(intent, slots, statusMsg) {
    const chatLog = document.getElementById("chat-log");
    const card = document.createElement("div");
    card.className = `msg assistant action-card action-card-${intent}`;
    card.style.animation = "fadeInUp 0.5s cubic-bezier(.23,1.01,.32,1)";

    // Define fields for each intent (extensible)
    const fieldDefs = {
      smart_receive: [
        { label: 'Item Code/Name', name: 'item_code', type: 'text', required: true, tooltip: 'Enter the item code or name.' },
        { label: 'Quantity', name: 'quantity', type: 'number', min: 1, required: true, tooltip: 'Enter the quantity to receive.' },
        { label: 'Warehouse', name: 'warehouse', type: 'text', required: true, tooltip: 'Warehouse code (e.g. WH1)' },
        { label: 'Location', name: 'location', type: 'text', tooltip: 'Location or bin (optional)' },
        { label: 'Batch No', name: 'batch_no', type: 'text', tooltip: 'Batch number (optional)' },
        { label: 'Status', name: 'status', type: 'select', options: [ 'ok', 'damaged' ], tooltip: 'Item condition' },
        { label: 'Customer', name: 'customer', type: 'text', tooltip: 'Customer name (optional)' },
        { label: 'Reference No', name: 'reference_no', type: 'text', tooltip: 'Reference or PO (optional)' },
      ],
      // Add more intents here as needed
    };

    const fields = fieldDefs[intent] || [];

    // Build the form fields
    let fieldsHtml = '';
    for (const f of fields) {
      if (f.type === 'select') {
        fieldsHtml += `<label title="${f.tooltip || ''}">${f.label}
          <select name="${f.name}">
            ${f.options.map(opt => `<option value="${opt}" ${slots[f.name] === opt ? 'selected' : ''}>${opt.toUpperCase()}</option>`).join('')}
          </select>
        </label>`;
      } else {
        fieldsHtml += `<label title="${f.tooltip || ''}">${f.label}
          <input name="${f.name}" type="${f.type}" ${f.min ? `min='${f.min}'` : ''} value="${slots[f.name] || slots.item_name || ''}" ${f.required ? 'required' : ''}>
        </label>`;
      }
    }

    card.innerHTML = `
      <div class="action-card-header">
        <span class="action-card-icon">${intent === 'smart_receive' ? '📥' : '⚡'}</span>
        <span class="action-card-title">${statusMsg || 'Action Required'}</span>
      </div>
      <form class="action-card-form">
        <div class="action-card-fields">${fieldsHtml}</div>
        <div class="action-card-actions">
          <button type="submit" class="btn primary">✓ Confirm</button>
        </div>
      </form>
    `;
    chatLog.appendChild(card);
    chatLog.scrollTop = chatLog.scrollHeight;

    // Animate card in
    setTimeout(() => { card.style.boxShadow = '0 4px 32px #0004'; }, 100);

    // Inline validation and tooltips
    card.querySelectorAll('input,select').forEach(input => {
      input.addEventListener('focus', e => {
        card.querySelectorAll('label').forEach(l => l.classList.remove('highlight'));
        input.parentElement.classList.add('highlight');
      });
      input.addEventListener('blur', e => {
        input.parentElement.classList.remove('highlight');
      });
    });

    // Handle form submission
    card.querySelector(".action-card-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const payload = {};
      let missing = [];
      for (const f of fields) {
        let val = form[f.name]?.value?.trim();
        if (f.type === 'number') val = Number(val);
        payload[f.name] = val;
        if (f.required && (!val || (f.type === 'number' && val <= 0))) missing.push(f.label);
      }
      if (missing.length) {
        addMessage(`❌ Please fill in: ${missing.join(', ')}`, "error");
        return;
      }
      // Send to backend for this intent
      try {
        card.querySelector("button[type='submit']").disabled = true;
        card.querySelector("button[type='submit']").textContent = "Saving…";
        let endpoint = '';
        if (intent === 'smart_receive') endpoint = '/receiving/smart-receive';
        // Add more intent endpoints as needed
        const res = await fetch(`${API_BASE}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || `Action failed: ${res.status}`);
        }
        card.remove();
        addStatusMessage(`✅ ${intent === 'smart_receive' ? `Received ${payload.quantity} × ${payload.item_code} into ${payload.warehouse} (Ref: ${payload.reference_no || 'N/A'}).` : 'Action completed.'}`);
        await refreshInventory({});
      } catch (err) {
        addMessage(`❌ ${err.message || "Error saving action."}`, "error");
        card.querySelector("button[type='submit']").disabled = false;
        card.querySelector("button[type='submit']").textContent = "✓ Confirm";
      }
    });
  }
});