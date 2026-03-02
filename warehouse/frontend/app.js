/* ============================================================
   Warehouse Copilot – app.js
   Single-window architecture: all operations use #workspacePanel.
   Intent understanding passes through /chat/interpret (Gemini NLP).
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
   Workspace Panel – replaces the old modal popup
   =========================================================================== */

const WORKSPACE_TITLES = {
  receive: "📥 Receive Stock",
  inventory: "📦 Inventory",
  report: "📊 Reports",
};

function showWorkspace(section) {
  const panel = document.getElementById("workspacePanel");
  const app = document.querySelector(".app");

  // Hide all sections, then show the requested one
  panel.querySelectorAll(".workspace-section").forEach(s => s.classList.remove("active"));
  const target = panel.querySelector(`#ws-${section}`);
  if (target) target.classList.add("active");

  // Update header title
  document.getElementById("workspaceTitle").textContent =
    WORKSPACE_TITLES[section] || "Workspace";

  // Reveal the panel
  panel.classList.remove("hidden");
  app.classList.add("workspace-open");
}

function hideWorkspace() {
  const panel = document.getElementById("workspacePanel");
  const app = document.querySelector(".app");
  panel.classList.add("hidden");
  app.classList.remove("workspace-open");
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
  params.append("_t", Date.now()); // CACHE BUSTER
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

/* ── handleDeleteLine: called after user confirms delete ─────────────────────
   Resolves the query from slots (reference_no, query, batch_no, etc.),
   then calls the appropriate DELETE endpoint and refreshes inventory.
   ─────────────────────────────────────────────────────────────────────────── */
async function handleDeleteLine(slots) {
  // Resolve what to delete: prefer reference_no, then general query
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

    // If the query looks like a reference code (e.g. PO-01, GRN-45), delete by reference
    const isReference = /[A-Za-z][\-\s]?\d|^PO|^GRN|^REF|^INV|^REC|^DO|^SO/i.test(query);

    if (isReference) {
      await deleteHeaderByRef(query);
    } else {
      // Try to find the line by searching inventory first, then delete by line_id
      const inv = await fetchInventory({ q: query });
      const rows = inv?.rows || [];
      if (rows.length === 0) {
        addStatusMessage(`❌ No record found matching '${query}'.`);
        return;
      }
      // If multiple rows, delete all lines under the same header_id
      const headerIds = [...new Set(rows.map(r => r.header_id))];
      for (const hid of headerIds) {
        // Delete all lines for this header, the backend will also clean up the header
        const lines = rows.filter(r => r.header_id === hid);
        for (const line of lines) {
          await deleteLine(line.line_id);
        }
      }
    }

    addStatusMessage(`✅ '${query}' deleted successfully.`);
    // Refresh inventory to reflect the deletion
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
   Inventory table – rendered inside #ws-inventory workspace section
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
  // Ensure workspace is open to inventory section
  showWorkspace("inventory");

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

/* Wire inventory table click actions (edit / save / delete) */
function wireInventoryActions() {
  const tbody = document.getElementById("inventoryBody");
  if (!tbody) return;

  tbody.addEventListener("click", async (e) => {
    const row = e.target.closest("tr");
    if (!row) return;

    // ── Edit ──
    if (e.target.closest(".row-edit")) {
      setRowEditing(row, true);
      return;
    }

    // ── Save ──
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

    // ── Delete ──
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

async function handleDeleteLine(slots) {
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
  await refreshInventory({ q: query });

  // Auto-edit: Check if the user's message contained words indicating an edit intent
  // The 'raw_message' isn't explicitly in slots, but we can check the query or assume 
  // if the intent was routed here and it matched our edit keywords, we should try to edit.
  // A safer approach: the backend API `/chat/interpret` could return the matched keyword,
  // but for now, let's just check the user's last message from the chat UI context.

  // Since we don't have direct access to the message in this function without altering signatures,
  // we can check if the query string itself contains "edit" etc (which is stripped), 
  // OR we pass intent/message down. Since we can't easily pass it without changing the dispatcher,
  // let's grab the last user message from the DOM!
  setTimeout(() => {
    const userMessages = document.querySelectorAll('.message.user .msg-text');
    if (userMessages.length === 0) return;
    const lastMsg = userMessages[userMessages.length - 1].innerText.toLowerCase();

    const isEditIntent = /\b(edit|modify|change|update)\b/.test(lastMsg);

    const tbody = document.getElementById("inventoryBody");
    if (!tbody) return;
    const rows = tbody.querySelectorAll("tr");

    // Only auto-edit if it was specifically requested and we found exactly one row
    if (isEditIntent && rows.length === 1) {
      setRowEditing(rows[0], true);
    }
  }, 100);
}

/* ===========================================================================
   Welcome message
   =========================================================================== */

function showWelcomeMessage() {
  addMessage(
    "📦 Warehouse Copilot ready.\n" +
    "How can I help you today?",
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

  // ── Keyboard shortcut ───────────────────────────────────────────────
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendBtn.click(); }
  });

  // ── Workspace close button ──────────────────────────────────────────
  workspaceClose.addEventListener("click", hideWorkspace);

  // ── Sidebar quick-action chips ──────────────────────────────────────
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

  // ── Inventory filter buttons ────────────────────────────────────────
  document.getElementById("invSearchBtn").addEventListener("click", () => {
    refreshInventory(collectInventoryFilters());
  });

  document.getElementById("invClearBtn").addEventListener("click", () => {
    ["inv_q", "inv_customer", "inv_reference", "inv_date_from", "inv_date_to"]
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    refreshInventory({});
  });

  // ── Line items: add / remove ────────────────────────────────────────
  addLineBtn.addEventListener("click", () => lineItemsBody.appendChild(createLineRow()));
  lineItemsBody.addEventListener("click", (e) => {
    if (e.target.classList.contains("remove-row")) {
      e.target.closest("tr").remove();
      ensureAtLeastOneRow();
    }
  });

  // ── Report: load full inventory ─────────────────────────────────────
  document.getElementById("loadReportBtn")?.addEventListener("click", () => {
    refreshInventory({});
  });

  // ── Cancel / Close receive form ─────────────────────────────────────
  closeModal.addEventListener("click", () => hideWorkspace());

  // ── Confirm Receive ─────────────────────────────────────────────────
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
     Main send button — NLP intent dispatcher
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

      // Show status message from backend (but not for plain chat replies)
      if (data.status && action !== "chat_reply") {
        addStatusMessage(data.status);
      }

      // ── request_info: backend needs more details from user ──
      if (action === "request_info") {
        return;
      }

      // ── Receive Stock ───────────────────────────────────────────────
      if (action === "open_receive_form" || intent === "receive_stock") {
        showWorkspace("receive");
        ensureAtLeastOneRow();
        return;
      }

      // ── Check Inventory ─────────────────────────────────────────────
      if (action === "show_inventory" || intent === "check_inventory") {
        await refreshInventory({});
        return;
      }

      // ── Report ──────────────────────────────────────────────────────
      if (action === "show_report" || intent === "report") {
        showWorkspace("report");
        addStatusMessage("📊 Report workspace opened. Click 'Load Full Report' to view data.");
        return;
      }

      // ── Open Record / Search ────────────────────────────────────────
      if (action === "open_record" || intent === "open_record") {
        await handleOpenRecord(pendingSlots);
        return;
      }

      // ── Adjust Quantity ─────────────────────────────────────────────
      if (action === "adjust_quantity" || intent === "adjust_quantity") {
        await handleAdjustQuantity(pendingSlots);
        return;
      }

      // ── Delete flow ─────────────────────────────────────────────────
      // IMPORTANT: check execute_delete FIRST — both stages share intent="delete_line"
      // so the confirm check must only match on action, not intent.
      if (action === "execute_delete" && data.confirmed) {
        await handleDeleteLine(pendingSlots);
        return;
      }

      if (action === "delete_cancelled") {
        return;
      }

      // Waiting for user confirmation — just show the prompt and stop
      if (action === "confirm_delete") {
        return;
      }

      // ── Fallback: generic chat reply ────────────────────────────────
      if (data.response) {
        addMessage(data.response, "assistant");
      } else {
        const chat = await fetchChatResponse(message);
        addMessage(chat?.reply || "I can help with receiving stock, checking inventory, editing, deleting, and reports.", "assistant");
      }

    } catch (err) {
      removeTypingIndicator();
      console.error(err);
      addMessage(`❌ ${err.message || "Error processing command."}`, "error");
    } finally {
      setInputEnabled(true);
    }
  });
});