// background.js — Refactored: clearer structure, single-responsibility modules, safer state

/** @typedef {number} TabId */
/** @typedef {number} WindowId */

/* ======================
 * Constants & Utilities
 * ====================== */

const STORAGE_KEYS = { QUEUES_BY_WINDOW: "queuesByWindow" };
// Safe modulo (handles negatives & empty arrays)
const safeMod = (n, m) => (m === 0 ? 0 : ((n % m) + m) % m);

// Ordered dedupe
function dedupeOrdered(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

async function getCurrentWindowActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function getTabTitle(id) {
  try { const t = await chrome.tabs.get(id); return t.title || "(no title)"; }
  catch { return "[closed]"; }
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title,
    message: String(message).slice(0, 1000),
  });
}

/* ======================
 * MRU Queue (persistent)
 * ====================== */

const MRUQueue = {
  async getAll() {
    const res = await chrome.storage.local.get([STORAGE_KEYS.QUEUES_BY_WINDOW]);
    const raw = res[STORAGE_KEYS.QUEUES_BY_WINDOW];
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  },

  async setAll(queuesByWindow) {
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUES_BY_WINDOW]: queuesByWindow });
  },

  async get(windowId) {
    const queuesByWindow = await this.getAll();
    const queueTabs = queuesByWindow[String(windowId)];
    return Array.isArray(queueTabs) ? queueTabs : [];
  },

  async set(windowId, queueTabs) {
    const queuesByWindow = await this.getAll();
    queuesByWindow[String(windowId)] = queueTabs;
    await this.setAll(queuesByWindow);
  },

  async delete(windowId) {
    const queuesByWindow = await this.getAll();
    delete queuesByWindow[String(windowId)];
    await this.setAll(queuesByWindow);
  },

  /** Move tid to the end (MRU) */
  async touch(windowId, tid) {
    if (tid == null) return;
    const curr = await this.get(windowId);
    const filtered = curr.filter((id) => id !== tid);
    const out = dedupeOrdered([...filtered, tid]);
    await this.set(windowId, out);
    console.log("[MRU] touch window", windowId, "->", out);
  },

  /** Remove closed tabs & dedupe */
  async clean(windowId, queueTabs) {
    const list = queueTabs ?? (await this.get(windowId));
    const checks = await Promise.allSettled(list.map((id) => chrome.tabs.get(id)));
    const valid = [];
    checks.forEach((r, i) => {
      if (r.status === "fulfilled") valid.push(list[i]);
      else console.warn("[MRU] drop closed in window", windowId, ":", list[i]);
    });
    return dedupeOrdered(valid);
  },

  /** Ensure active tab is present once at any position (no reorder) */
  ensureActivePresent(queueTabs, activeId) {
    if (activeId != null && !queueTabs.includes(activeId)) {
      return [...queueTabs, activeId];
    }
    return queueTabs;
  },
};

/* ======================
 * Cycle Session (ephemeral)
 * ====================== */

class CycleSession {
  constructor(windowId) {
    /** @type {WindowId} */ this.windowId = windowId;
    this.reset();
  }

  reset() {
    /** @type {boolean} */ this.active = false;
    /** @type {TabId|null} */ this.suppressActivationFor = null;
    /** @type {TabId[]} */ this.snapshot = [];
    /** @type {number} */ this.cursor = -1;
    /** @type {TabId|null} */ this.fromId = null;
    /** @type {Promise<void>|null} */ this.finalizePromise = null;
  }

  get isActive() { return this.active; }

  /** Start or refresh snapshot; returns boolean indicating (re)started */
  async startIfNeeded(activeId) {
    if (!this.active || this.snapshot.length === 0) {
      let q = await MRUQueue.get(this.windowId);
      q = await MRUQueue.clean(this.windowId, q);
      q = MRUQueue.ensureActivePresent(q, activeId);
      if (q.length === 0) return false;

      this.snapshot = q.slice(); // fixed during cycling
      this.cursor = this.snapshot.indexOf(activeId);
      if (this.cursor === -1) {
        this.snapshot.push(activeId);
        this.cursor = this.snapshot.length - 1;
      }
      this.fromId = activeId;
      this.active = true;
      console.log("[Cycle] start window", this.windowId, ":", this.snapshot, "cursor@", this.cursor);
      return true;
    }
    // already active
    return true;
  }

  resyncCursorTo(tabId) {
    const idx = this.snapshot.indexOf(tabId);
    if (idx !== -1) this.cursor = idx;
  }

  /** Move cursor by step and return target tab id (skips no-op self) */
  pickNext(step, activeId) {
    if (this.snapshot.length === 0) return null;
    this.cursor = safeMod(this.cursor + step, this.snapshot.length);
    let target = this.snapshot[this.cursor];
    if (this.snapshot.length > 1 && target === activeId) {
      this.cursor = safeMod(this.cursor + step, this.snapshot.length);
      target = this.snapshot[this.cursor];
    }
    return target;
  }

  /** Suppress the onActivated caused by our own switch */
  suppressOnce(tabId) {
    this.suppressActivationFor = tabId;
  }

  consumeSuppression(tabId) {
    if (this.suppressActivationFor === tabId) {
      console.log("[Cycle] suppressed self-activation for", tabId);
      this.suppressActivationFor = null;
      return true;
    }
    return false;
  }

  async ensureSettled() {
    if (this.finalizePromise) {
      await this.finalizePromise;
    }
  }

  /** Finalize: reorder MRU so final active is MRU and start tab is 2nd MRU */
  finalize(reason) {
    if (!this.isActive) {
      return Promise.resolve();
    }

    if (this.finalizePromise) {
      return this.finalizePromise;
    }

    const promise = this.finalizeNow(reason).finally(() => {
      if (this.finalizePromise === promise) {
        this.finalizePromise = null;
      }
    });

    this.finalizePromise = promise;
    return promise;
  }

  async finalizeNow(reason) {
    const tabs = await chrome.tabs.query({ active: true, windowId: this.windowId });
    const finalId = tabs && tabs[0] ? tabs[0].id : null;
    const fromId = this.fromId;

    let q = await MRUQueue.get(this.windowId);
    q = await MRUQueue.clean(this.windowId, q);

    // remove both, then re-append in desired MRU order
    let out = q.filter((id) => id !== finalId && id !== fromId);

    if (finalId != null && fromId != null && finalId !== fromId) {
      out.push(fromId);  // second-most-recent
      out.push(finalId); // most-recent
    } else if (finalId != null) {
      out.push(finalId);
    } else if (fromId != null) {
      out.push(fromId);
    }

    out = dedupeOrdered(out);
    await MRUQueue.set(this.windowId, out);
    console.log("[Cycle] finalized window", this.windowId, "reason:", reason || "release", "Queue:", out);

    // reset state
    this.reset();
  }
}

const cyclesByWindow = new Map();

function getCycle(windowId) {
  if (!cyclesByWindow.has(windowId)) {
    cyclesByWindow.set(windowId, new CycleSession(windowId));
  }
  return cyclesByWindow.get(windowId);
}

/* ======================
 * Command Handlers
 * ====================== */

async function handleShowQueue() {
  const activeTab = await getCurrentWindowActiveTab();
  if (!activeTab) return;

  const queueTabs = await MRUQueue.get(activeTab.windowId);
  if (queueTabs.length === 0) {
    notify("Tab Queue", "Queue is empty.");
    return;
  }
  const reversed = [...queueTabs].reverse(); // most recent first
  const titles = await Promise.all(reversed.map(getTabTitle));
  const message = titles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  notify("Tab Queue", message);
}

async function handleSwitch(step) {
  const activeTab = await getCurrentWindowActiveTab();
  if (!activeTab) return;

  const activeId = activeTab.id;
  const windowId = activeTab.windowId;
  const cycle = getCycle(windowId);
  await cycle.ensureSettled();

  const started = await cycle.startIfNeeded(activeId);
  if (!started) return;

  // If user manually clicked during the cycle, re-align
  cycle.resyncCursorTo(activeId);

  const targetId = cycle.pickNext(step, activeId);
  if (targetId == null || targetId === activeId) return;

  console.log("[Cycle] switching window", windowId, "->", targetId);
  cycle.suppressOnce(targetId);
  try {
    await chrome.tabs.update(targetId, { active: true });
  } catch (e) {
    console.warn("[Cycle] failed to switch:", e);
    // drop suppression to avoid hiding the next real activation
    cycle.suppressActivationFor = null;
    return;
  }

  // Do not reorder MRU during cycle; finalization happens on modifier release.
}

/* ======================
 * Event Wiring
 * ====================== */

chrome.commands.onCommand.addListener(async (command) => {
  console.log("[Cmd]", command);
  if (command === "showQueue") return handleShowQueue();
  if (command === "switchBack")  return handleSwitch(-1);
  if (command === "switchForward") return handleSwitch(1);
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const cycle = getCycle(windowId);
  if (cycle.consumeSuppression(tabId)) return;

  console.log("[Tabs] user activation window", windowId, ":", tabId);
  if (!cycle.isActive) {
    // Outside cycling -> normal MRU
    await MRUQueue.touch(windowId, tabId);
  } else {
    // During cycling: keep queue frozen and only track manual picks.
    cycle.resyncCursorTo(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const windowId = removeInfo.windowId;
  const cycle = getCycle(windowId);
  const q = await MRUQueue.get(windowId);
  const filtered = q.filter((id) => id !== tabId);
  if (filtered.length !== q.length) {
    const cleaned = dedupeOrdered(filtered);
    await MRUQueue.set(windowId, cleaned);
    console.log("[Tabs] removed from window", windowId, ":", tabId, "queue ->", cleaned);
  }

  // Keep snapshot clean, too
  if (cycle.isActive && cycle.snapshot.length) {
    const idx = cycle.snapshot.indexOf(tabId);
    if (idx !== -1) {
      cycle.snapshot.splice(idx, 1);
      if (cycle.cursor >= cycle.snapshot.length) {
        cycle.cursor = cycle.snapshot.length - 1;
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !sender.tab || typeof sender.tab.windowId === "undefined") {
    return;
  }

  const cycle = getCycle(sender.tab.windowId);
  if (!cycle.isActive) {
    return;
  }

  if (message.type === "modifiersObserved") {
    cycle.finalize("new modifier hold").catch(console.error);
    return;
  }

  if (message.type === "modifiersReleased") {
    cycle.finalize("modifier release").catch(console.error);
  }
});

/* ======================
 * Startup / Install
 * ====================== */

async function validateQueue() {
  const queuesByWindow = await MRUQueue.getAll();
  const cleanedByWindow = {};

  for (const [windowId, queueTabs] of Object.entries(queuesByWindow)) {
    const cleaned = await MRUQueue.clean(Number(windowId), Array.isArray(queueTabs) ? queueTabs : []);
    if (cleaned.length) {
      cleanedByWindow[windowId] = dedupeOrdered(cleaned);
    }
  }

  await MRUQueue.setAll(cleanedByWindow);
  console.log("[Init] queues validated");
}

chrome.runtime.onStartup.addListener(validateQueue);
chrome.runtime.onInstalled.addListener(validateQueue);
chrome.windows.onRemoved.addListener(async (windowId) => {
  cyclesByWindow.delete(windowId);
  await MRUQueue.delete(windowId);
});
