/**
 * ============================================================================
 * CRM - Client-side Interactive Script (script.js)
 * ============================================================================
 * Handles:
 * 1. Mobile sidebar toggle
 * 2. Universal modal opening/closing (Add, Edit, Delete Confirm)
 * 3. Dynamic Edit Modal data population from HTML data-* attributes
 * 4. Dynamic Delete Confirmation modal with target name
 * 5. Instant client-side table search & quick filtering
 * 6. Alert dismissals
 * 7. Chart.js rendering on Reports page (with graceful pure-SVG fallback)
 * ============================================================================
 */

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  initSidebar();
  initModals();
  initAlerts();
  initDynamicModals();
  initClientTableSearch();
  initAiAssistant();
});

// ---------------------------------------------------------------------------
// 0. DARK / LIGHT THEME TOGGLE & SETTINGS SYNC
// ---------------------------------------------------------------------------
function initThemeToggle() {
  const htmlEl = document.documentElement;
  const toggleBtn = document.getElementById("themeToggleBtn");
  const settingsForm = document.getElementById("businessSettingsForm");
  const settingsThemeSelect = document.getElementById("setting_theme");

  function syncToggleUi(theme) {
    if (!toggleBtn) return;
    const isDark = theme === "dark";
    const moon = toggleBtn.querySelector('[data-theme-icon="moon"]');
    const sun = toggleBtn.querySelector('[data-theme-icon="sun"]');
    const label = toggleBtn.querySelector("[data-theme-label]");
    if (moon) moon.style.display = isDark ? "none" : "";
    if (sun) sun.style.display = isDark ? "" : "none";
    if (label) label.textContent = isDark ? "Light" : "Dark";
    toggleBtn.setAttribute("aria-pressed", isDark ? "true" : "false");
  }

  function applyTheme(theme, persistServer) {
    const normalized = theme === "dark" || theme === "indigo" ? theme : "light";
    htmlEl.setAttribute("data-theme", normalized);
    try {
      localStorage.setItem("crm-theme", normalized);
    } catch {
      // ignore storage errors
    }
    if (settingsThemeSelect) {
      settingsThemeSelect.value = normalized;
    }
    syncToggleUi(normalized);

    if (window.__lastReportsData && typeof renderReportsCharts === "function") {
      renderReportsCharts(window.__lastReportsData);
    }

    if (persistServer) {
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      const csrf = csrfMeta ? csrfMeta.getAttribute("content") || "" : "";
      if (csrf) {
        fetch("/api/theme", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
          },
          body: JSON.stringify({ theme: normalized }),
        }).catch(() => {});
      }
    }
  }

  const initialTheme = htmlEl.getAttribute("data-theme") || "light";
  syncToggleUi(initialTheme);

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const current = htmlEl.getAttribute("data-theme") || "light";
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next, true);
    });
  }

  if (settingsForm && settingsThemeSelect) {
    settingsForm.addEventListener("submit", () => {
      try {
        localStorage.setItem("crm-theme", settingsThemeSelect.value || "light");
      } catch {
        // ignore storage errors
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 1. MOBILE SIDEBAR TOGGLE
// ---------------------------------------------------------------------------
function initSidebar() {
  const toggleBtn = document.getElementById("mobileSidebarToggle");
  const sidebar = document.getElementById("appSidebar");
  const backdrop = document.getElementById("mobileNavBackdrop");

  if (toggleBtn && sidebar) {
    const setSidebarOpen = (open) => {
      sidebar.classList.toggle("open", open);
      if (backdrop) backdrop.classList.toggle("active", open);
      toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.classList.toggle("nav-open", open);
    };

    toggleBtn.addEventListener("click", () => {
      const shouldOpen = !sidebar.classList.contains("open");
      setSidebarOpen(shouldOpen);
    });

    // Close when clicking outside on mobile
    document.addEventListener("click", (e) => {
      if (
        window.innerWidth <= 768 &&
        sidebar.classList.contains("open") &&
        !sidebar.contains(e.target) &&
        !toggleBtn.contains(e.target)
      ) {
        setSidebarOpen(false);
      }
    });

    if (backdrop) {
      backdrop.addEventListener("click", () => setSidebarOpen(false));
    }

    window.addEventListener("resize", () => {
      if (window.innerWidth > 768) setSidebarOpen(false);
    });
  }
}

// ---------------------------------------------------------------------------
// 2. MODAL CONTROLS (Open, Close, Backdrop Click, Esc Key)
// ---------------------------------------------------------------------------
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add("active");
    document.body.style.overflow = "hidden"; // Prevent scrolling
    // Autofocus first input inside modal
    const firstInput = modal.querySelector("input:not([type=hidden]), select, textarea");
    if (firstInput) firstInput.focus();
  }
}

function closeModal(modalOrId) {
  const modal = typeof modalOrId === "string" ? document.getElementById(modalOrId) : modalOrId;
  if (modal) {
    modal.classList.remove("active");
    document.body.style.overflow = "";
  }
}

function initModals() {
  // Click on backdrop to close
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        closeModal(overlay);
      }
    });
  });

  // Buttons with data-modal-close
  document.querySelectorAll("[data-modal-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = btn.closest(".modal-overlay");
      if (modal) closeModal(modal);
    });
  });

  // Buttons with data-modal-open
  document.querySelectorAll("[data-modal-open]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const modalId = btn.getAttribute("data-modal-open");
      openModal(modalId);
    });
  });

  // Escape key closes open modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const activeModal = document.querySelector(".modal-overlay.active");
      if (activeModal) closeModal(activeModal);
    }
  });
}

// ---------------------------------------------------------------------------
// 3. DYNAMIC EDIT & DELETE MODALS
// ---------------------------------------------------------------------------
function initDynamicModals() {
  // A. Edit Customer Modal Population
  document.querySelectorAll(".btn-edit-customer").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const name = btn.getAttribute("data-name");
      const email = btn.getAttribute("data-email");
      const phone = btn.getAttribute("data-phone");
      const company = btn.getAttribute("data-company");
      const address = btn.getAttribute("data-address");
      const status = btn.getAttribute("data-status");
      const notes = btn.getAttribute("data-notes");

      const form = document.getElementById("editCustomerForm");
      const customerId = Number.parseInt(id, 10);
      if (form) {
        if (!Number.isInteger(customerId) || customerId < 1) return;
        form.action = `/customers/edit/${customerId}`;
        document.getElementById("edit_customer_name").value = name || "";
        document.getElementById("edit_customer_email").value = email || "";
        document.getElementById("edit_customer_phone").value = phone || "";
        document.getElementById("edit_customer_company").value = company || "";
        document.getElementById("edit_customer_address").value = address || "";
        document.getElementById("edit_customer_status").value = status || "Active";
        document.getElementById("edit_customer_notes").value = notes || "";
        openModal("editCustomerModal");
      }
    });
  });

  // B. Edit Follow-up Modal Population
  document.querySelectorAll(".btn-edit-followup").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const reason = btn.getAttribute("data-reason");
      const date = btn.getAttribute("data-date");
      const priority = btn.getAttribute("data-priority");
      const status = btn.getAttribute("data-status");

      const form = document.getElementById("editFollowupForm");
      const followupId = Number.parseInt(id, 10);
      if (form) {
        if (!Number.isInteger(followupId) || followupId < 1) return;
        form.action = `/followups/edit/${followupId}`;
        document.getElementById("edit_followup_reason").value = reason || "";
        document.getElementById("edit_followup_date").value = date || "";
        document.getElementById("edit_followup_priority").value = priority || "Medium";
        document.getElementById("edit_followup_status").value = status || "Pending";
        openModal("editFollowupModal");
      }
    });
  });

  // C. Universal Delete Confirmation Modal
  document.querySelectorAll(".btn-confirm-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const actionUrl = btn.getAttribute("data-action");
      const title = btn.getAttribute("data-title") || "this record";

      const deleteForm = document.getElementById("universalDeleteForm");
      const deleteText = document.getElementById("deleteConfirmItemText");
      const deleteMatch = (actionUrl || "").match(/^\/(customers|interactions|followups)\/delete\/(\d+)$/);

      if (deleteForm && deleteMatch) {
        const entity = deleteMatch[1];
        const recordId = Number.parseInt(deleteMatch[2], 10);
        if (!Number.isInteger(recordId) || recordId < 1) return;
        if (entity === "customers") {
          deleteForm.action = `/customers/delete/${recordId}`;
        } else if (entity === "interactions") {
          deleteForm.action = `/interactions/delete/${recordId}`;
        } else if (entity === "followups") {
          deleteForm.action = `/followups/delete/${recordId}`;
        } else {
          return;
        }
        if (deleteText) {
          deleteText.textContent = `Are you sure you want to delete ${title}? This action cannot be undone.`;
        }
        openModal("deleteConfirmModal");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 4. INSTANT CLIENT-SIDE SEARCH
// ---------------------------------------------------------------------------
function initClientTableSearch() {
  const searchInput = document.getElementById("clientTableSearch");
  const targetTable = document.querySelector(".data-table tbody");

  if (searchInput && targetTable) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.toLowerCase().trim();
      const rows = targetTable.querySelectorAll("tr");

      let visibleCount = 0;
      rows.forEach((row) => {
        // Skip empty state row if present
        if (row.classList.contains("no-records-row")) return;

        const text = row.textContent.toLowerCase();
        if (text.includes(query)) {
          row.style.display = "";
          visibleCount++;
        } else {
          row.style.display = "none";
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// 5. ALERT AUTO-DISMISS
// ---------------------------------------------------------------------------
function initAlerts() {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll(".alert").forEach((alert) => {
    // Auto fade after 5 seconds
    setTimeout(() => {
      if (prefersReducedMotion) {
        alert.remove();
        return;
      }
      alert.style.transition = "opacity 0.4s ease";
      alert.style.opacity = "0";
      setTimeout(() => alert.remove(), 400);
    }, 5000);

    // Manual close button
    const closeBtn = alert.querySelector(".alert-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        alert.remove();
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 6. REPORTS CHARTS INITIALIZER (Chart.js + SVG Fallback)
// ---------------------------------------------------------------------------
const activeReportCharts = [];

function renderReportsCharts(reportsData) {
  if (!reportsData) return;
  window.__lastReportsData = reportsData;

  while (activeReportCharts.length > 0) {
    const ch = activeReportCharts.pop();
    if (ch && typeof ch.destroy === "function") ch.destroy();
  }

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const borderColor = isDark ? "#111827" : "#ffffff";
  const labelColor = isDark ? "#cbd5e1" : "#475569";
  const gridColor = isDark ? "#1e293b" : "#f1f5f9";
  const tickColor = isDark ? "#94a3b8" : "#64748b";

  const isChartJsAvailable = typeof Chart !== "undefined";

  if (isChartJsAvailable) {
    // A. Customer Status Doughnut Chart
    const statusCtx = document.getElementById("customerStatusChart");
    if (statusCtx) {
      activeReportCharts.push(
        new Chart(statusCtx, {
          type: "doughnut",
          data: {
            labels: Object.keys(reportsData.customer_status),
            datasets: [
              {
                data: Object.values(reportsData.customer_status),
                backgroundColor: ["#10b981", "#94a3b8", "#f59e0b"],
                hoverOffset: 4,
                borderWidth: 2,
                borderColor,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: "bottom",
                labels: { boxWidth: 12, font: { size: 12 }, color: labelColor },
              },
            },
          },
        })
      );
    }

    // B. Interaction Types Bar Chart
    const interCtx = document.getElementById("interactionTypesChart");
    if (interCtx) {
      activeReportCharts.push(
        new Chart(interCtx, {
          type: "bar",
          data: {
            labels: Object.keys(reportsData.interaction_types),
            datasets: [
              {
                label: "Interactions",
                data: Object.values(reportsData.interaction_types),
                backgroundColor: isDark ? "#6366f1" : "#4f46e5",
                borderRadius: 6,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: { stepSize: 1, precision: 0, color: tickColor },
                grid: { color: gridColor },
              },
              x: {
                ticks: { color: tickColor },
                grid: { display: false },
              },
            },
          },
        })
      );
    }

    // C. Follow-up Priority & Status Chart
    const fuCtx = document.getElementById("followupsPriorityChart");
    if (fuCtx) {
      activeReportCharts.push(
        new Chart(fuCtx, {
          type: "pie",
          data: {
            labels: ["High Priority", "Medium Priority", "Low Priority"],
            datasets: [
              {
                data: [
                  reportsData.followup_priority["High"] || 0,
                  reportsData.followup_priority["Medium"] || 0,
                  reportsData.followup_priority["Low"] || 0,
                ],
                backgroundColor: ["#ef4444", "#f59e0b", "#10b981"],
                borderWidth: 2,
                borderColor,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: "bottom",
                labels: { boxWidth: 12, font: { size: 12 }, color: labelColor },
              },
            },
          },
        })
      );
    }
  } else {
    // Graceful offline pure CSS/DOM bar visualization fallback
    console.log("Chart.js CDN not reachable; activating built-in pure HTML chart fallback.");
    renderSvgFallback(reportsData);
  }
}

function renderSvgFallback(data) {
  const container = document.getElementById("interactionTypesChart");
  if (container) {
    const parent = container.parentElement;
    parent.innerHTML = `
      <div class="svg-bar-chart">
        ${Object.entries(data.interaction_types)
          .map(([type, count]) => {
            const max = Math.max(...Object.values(data.interaction_types), 1);
            const heightPercent = Math.max((count / max) * 100, 8);
            return `
            <div class="svg-bar-item">
              <span class="svg-bar-val">${count}</span>
              <div class="svg-bar-pillar" style="height: ${heightPercent}%;"></div>
              <span class="svg-bar-label">${type}</span>
            </div>
          `;
          })
          .join("")}
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// 7. CRM AI ASSISTANT (Multi-turn Gemini Chat, Drafts & Follow-up Approvals)
// ---------------------------------------------------------------------------
function initAiAssistant() {
  const roots = Array.from(document.querySelectorAll("[data-ai-root]"));
  if (roots.length === 0) return;

  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const getCsrf = () => (csrfMeta ? csrfMeta.getAttribute("content") || "" : "");

  async function fetchJsonSafe(url, options = {}) {
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };
    const res = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers,
    });
    const rawText = await res.text();
    let data = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        if (res.status === 401) {
          throw new Error("Your session has expired. Please refresh the page to sign in again.");
        }
        throw new Error(
          `The server returned an unexpected non-JSON response (HTTP ${res.status}). If the app just updated, please refresh the page and try again.`
        );
      }
    }
    if (!res.ok) {
      const msg = (data && data.error) || `Request failed (HTTP ${res.status}).`;
      throw new Error(msg);
    }
    return data || {};
  }

  const drawer = document.getElementById("aiAssistantDrawer");
  const openDrawerBtn = document.getElementById("openAiDrawerBtn");
  const closeDrawerBtn = document.getElementById("closeAiDrawerBtn");
  let drawerLoaded = false;

  const controllers = [];

  roots.forEach((root) => {
    const isAdmin = root.getAttribute("data-ai-is-admin") === "1";
    const isDrawer = root.getAttribute("data-ai-drawer") === "1";
    const threadEl = root.querySelector("[data-ai-thread]");
    const errorEl = root.querySelector("[data-ai-error]");
    const formEl = root.querySelector("[data-ai-form]");
    const inputEl = root.querySelector("[data-ai-input]");
    const submitEl = root.querySelector("[data-ai-submit]");
    const clearEl = root.querySelector("[data-ai-clear]");
    const customerEl = root.querySelector("[data-ai-customer]");
    const speedEl = root.querySelector("[data-ai-speed]");
    const channelEl = root.querySelector("[data-ai-channel]");
    const toneEl = root.querySelector("[data-ai-tone]");
    const modeButtons = Array.from(root.querySelectorAll("[data-ai-mode-btn]"));
    const messageOptionsEls = Array.from(root.querySelectorAll("[data-ai-message-options]"));
    const promptButtons = Array.from(document.querySelectorAll(isDrawer ? "#aiAssistantDrawer [data-ai-prompt]" : "[data-ai-prompt]"));

    let currentMode = root.getAttribute("data-ai-initial-mode") || "general";
    let isBusy = false;
    let history = [];

    const initialHistoryEl = !isDrawer ? document.getElementById("aiInitialHistoryData") : null;
    if (initialHistoryEl) {
      try {
        history = JSON.parse(initialHistoryEl.textContent || "[]");
      } catch {
        history = [];
      }
    }

    function setError(msg) {
      if (!errorEl) return;
      if (!msg) {
        errorEl.style.display = "none";
        errorEl.textContent = "";
      } else {
        errorEl.style.display = "block";
        errorEl.textContent = msg;
      }
    }

    function setMode(nextMode) {
      currentMode = nextMode || "general";
      modeButtons.forEach((btn) => {
        const active = btn.getAttribute("data-ai-mode-btn") === currentMode;
        btn.classList.toggle("active", active);
      });
      const showMsgOpts = currentMode === "message";
      messageOptionsEls.forEach((el) => {
        el.style.display = showMsgOpts ? "" : "none";
      });
    }

    function populateCustomers(customers) {
      if (!customerEl || !Array.isArray(customers)) return;
      const existingVal = customerEl.value;
      while (customerEl.options.length > 1) {
        customerEl.remove(1);
      }
      customers.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = String(c.id);
        opt.textContent = c.company ? `${c.name} (${c.company})` : c.name;
        customerEl.appendChild(opt);
      });
      if (existingVal) customerEl.value = existingVal;
    }

    function buildDraftCard(draft) {
      const card = document.createElement("div");
      card.className = "ai-draft-card";

      const meta = document.createElement("div");
      meta.className = "ai-card-meta";

      const label = document.createElement("span");
      label.textContent = `${draft.channel} Draft · ${draft.tone} Tone`;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn-secondary btn-sm";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", async () => {
        const fullText = draft.channel === "Email" && draft.subject
          ? `Subject: ${draft.subject}\n\n${draft.body}`
          : draft.body;
        try {
          await navigator.clipboard.writeText(fullText);
          copyBtn.textContent = "Copied";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1800);
        } catch {
          copyBtn.textContent = "Copy failed";
        }
      });

      meta.appendChild(label);
      meta.appendChild(copyBtn);
      card.appendChild(meta);

      if (draft.subject) {
        const subj = document.createElement("div");
        subj.className = "ai-draft-subject";
        subj.textContent = draft.subject;
        card.appendChild(subj);
      }

      const body = document.createElement("div");
      body.className = "ai-draft-body";
      body.textContent = draft.body;
      card.appendChild(body);

      return card;
    }

    function buildFollowupCard(fu) {
      const card = document.createElement("div");
      card.className = "ai-followup-card";

      const meta = document.createElement("div");
      meta.className = "ai-card-meta";
      const tag = document.createElement("span");
      tag.textContent = "Suggested Follow-up Task";
      meta.appendChild(tag);
      card.appendChild(meta);

      const row = document.createElement("div");
      row.className = "ai-followup-row";

      const info = document.createElement("div");
      info.className = "ai-followup-info";

      const title = document.createElement("div");
      title.className = "ai-followup-title";
      title.textContent = fu.customerName;

      const reason = document.createElement("div");
      reason.className = "ai-followup-reason";
      reason.textContent = fu.reason;

      const sub = document.createElement("div");
      sub.className = "ai-followup-meta";
      sub.textContent = `Scheduled: ${fu.followUpDate} · Priority: ${fu.priority}`;

      info.appendChild(title);
      info.appendChild(reason);
      info.appendChild(sub);
      row.appendChild(info);

      if (isAdmin) {
        const approveBtn = document.createElement("button");
        approveBtn.type = "button";
        approveBtn.className = "btn btn-primary btn-sm";
        approveBtn.textContent = "Approve & Create";
        approveBtn.addEventListener("click", async () => {
          approveBtn.disabled = true;
          approveBtn.textContent = "Creating...";
          setError("");
          try {
            await fetchJsonSafe("/api/ai/approve-followup", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": getCsrf()
              },
              body: JSON.stringify({
                customerId: fu.customerId,
                reason: fu.reason,
                followUpDate: fu.followUpDate,
                priority: fu.priority
              })
            });
            approveBtn.className = "btn btn-success btn-sm";
            approveBtn.textContent = "Approved & Created";
          } catch (err) {
            approveBtn.disabled = false;
            approveBtn.textContent = "Approve & Create";
            setError(err instanceof Error ? err.message : "Approval failed.");
          }
        });
        row.appendChild(approveBtn);
      } else {
        const note = document.createElement("span");
        note.className = "ai-followup-meta";
        note.textContent = "Admin approval required";
        row.appendChild(note);
      }

      card.appendChild(row);
      return card;
    }

    function renderThread() {
      if (!threadEl) return;
      threadEl.textContent = "";

      if (!Array.isArray(history) || history.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ai-empty-thread";
        const h4 = document.createElement("h4");
        h4.textContent = "Ask your CRM AI Assistant";
        const p = document.createElement("p");
        p.textContent = "Ask about active customers, overdue follow-ups, monthly interaction summaries, customer history briefings, or draft ready-to-send emails and WhatsApp messages.";
        empty.appendChild(h4);
        empty.appendChild(p);
        threadEl.appendChild(empty);
        return;
      }

      history.forEach((turn) => {
        const msgWrap = document.createElement("div");
        msgWrap.className = `ai-msg ${turn.role === "user" ? "ai-msg-user" : "ai-msg-model"}`;

        const bubble = document.createElement("div");
        bubble.className = "ai-bubble";
        bubble.textContent = turn.text;
        msgWrap.appendChild(bubble);

        if (turn.role === "model" && turn.draftMessage) {
          msgWrap.appendChild(buildDraftCard(turn.draftMessage));
        }
        if (turn.role === "model" && Array.isArray(turn.suggestedFollowups)) {
          turn.suggestedFollowups.forEach((fu) => {
            msgWrap.appendChild(buildFollowupCard(fu));
          });
        }

        threadEl.appendChild(msgWrap);
      });

      if (isBusy) {
        const pendingWrap = document.createElement("div");
        pendingWrap.className = "ai-msg ai-msg-model";
        const pendingBubble = document.createElement("div");
        pendingBubble.className = "ai-bubble";
        pendingBubble.textContent = "Analyzing CRM data...";
        pendingWrap.appendChild(pendingBubble);
        threadEl.appendChild(pendingWrap);
      }

      threadEl.scrollTop = threadEl.scrollHeight;
    }

    async function sendPrompt(rawText) {
      const message = String(rawText || "").trim();
      if (!message || isBusy) return;

      setError("");
      isBusy = true;
      if (submitEl) submitEl.disabled = true;

      const optimisticUserTurn = { role: "user", text: message, mode: currentMode };
      history = [...history, optimisticUserTurn];
      if (inputEl) inputEl.value = "";
      renderThread();

      try {
        const data = await fetchJsonSafe("/api/ai/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": getCsrf()
          },
          body: JSON.stringify({
            message,
            mode: currentMode,
            speed: speedEl ? speedEl.value : "local",
            customerId: customerEl && customerEl.value ? Number(customerEl.value) : null,
            channel: channelEl ? channelEl.value : "Email",
            tone: toneEl ? toneEl.value : "Friendly"
          })
        });
        history = Array.isArray(data.history) ? data.history : history;
      } catch (err) {
        history = history.slice(0, -1);
        if (inputEl) inputEl.value = message;
        setError(err instanceof Error ? err.message : "Failed to reach CRM AI service.");
      } finally {
        isBusy = false;
        if (submitEl) submitEl.disabled = false;
        renderThread();
      }
    }

    async function loadRemoteHistory() {
      try {
        const data = await fetchJsonSafe("/api/ai/history");
        if (Array.isArray(data.history)) {
          history = data.history;
        }
        if (Array.isArray(data.customers)) {
          populateCustomers(data.customers);
        }
        renderThread();
      } catch {
        // ignore transient drawer load errors
      }
    }

    modeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        setMode(btn.getAttribute("data-ai-mode-btn") || "general");
      });
    });

    promptButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-ai-mode");
        const setChannel = btn.getAttribute("data-ai-set-channel");
        const setTone = btn.getAttribute("data-ai-set-tone");
        if (mode) setMode(mode);
        if (setChannel && channelEl) channelEl.value = setChannel;
        if (setTone && toneEl) toneEl.value = setTone;
        const prompt = btn.getAttribute("data-ai-prompt") || "";
        sendPrompt(prompt);
      });
    });

    if (formEl) {
      formEl.addEventListener("submit", (e) => {
        e.preventDefault();
        sendPrompt(inputEl ? inputEl.value : "");
      });
    }

    if (inputEl) {
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendPrompt(inputEl.value);
        }
      });
    }

    if (clearEl) {
      clearEl.addEventListener("click", async () => {
        setError("");
        try {
          await fetchJsonSafe("/api/ai/clear", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": getCsrf()
            },
            body: "{}"
          });
          history = [];
          renderThread();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not clear conversation.");
        }
      });
    }

    setMode(currentMode);
    renderThread();

    const initialPrompt = root.getAttribute("data-ai-initial-prompt");
    if (!isDrawer && initialPrompt) {
      sendPrompt(initialPrompt);
    }

    controllers.push({
      isDrawer,
      setMode,
      setCustomer: (cid) => {
        if (customerEl && cid) customerEl.value = String(cid);
      },
      loadRemoteHistory,
      sendPrompt
    });
  });

  const drawerController = controllers.find((c) => c.isDrawer);

  function openAiDrawer() {
    if (!drawer) return;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    if (drawerController && !drawerLoaded) {
      drawerLoaded = true;
      drawerController.loadRemoteHistory();
    }
  }

  function closeAiDrawer() {
    if (!drawer) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }

  if (openDrawerBtn) {
    openDrawerBtn.addEventListener("click", openAiDrawer);
  }
  if (closeDrawerBtn) {
    closeDrawerBtn.addEventListener("click", closeAiDrawer);
  }
  if (drawer) {
    drawer.addEventListener("click", (e) => {
      if (e.target === drawer) closeAiDrawer();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawer.classList.contains("open")) {
        closeAiDrawer();
      }
    });
  }

  document.querySelectorAll(".btn-ai-customer-action").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cid = btn.getAttribute("data-ai-customer-id");
      const mode = btn.getAttribute("data-ai-mode") || "history";
      const prompt = btn.getAttribute("data-ai-prompt") || "";
      if (drawerController) {
        openAiDrawer();
        if (!drawerLoaded) {
          drawerLoaded = true;
        }
        await drawerController.loadRemoteHistory();
        drawerController.setCustomer(cid);
        drawerController.setMode(mode);
        if (prompt) drawerController.sendPrompt(prompt);
      } else {
        window.location.href = `/ai-assistant?customerId=${encodeURIComponent(cid || "")}&mode=${encodeURIComponent(mode)}&prompt=${encodeURIComponent(prompt)}`;
      }
    });
  });
}
