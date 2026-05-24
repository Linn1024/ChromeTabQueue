/** @typedef {number} TabId */
/** @typedef {number} WindowId */

const STORAGE_KEY = "queuesByWindow";
const SAME_HOLD_COMMAND_GAP_MS = 700;

let storageLock = Promise.resolve();
const cycleByWindow = new Map();
const modifiersHeldByWindow = new Map();

const mod = (n, m) => (m === 0 ? 0 : ((n % m) + m) % m);

function unique(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

async function locked(fn) {
  const previous = storageLock;
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const nextLock = previous.catch(() => {}).then(() => current);
  storageLock = nextLock;

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (storageLock === nextLock) {
      storageLock = Promise.resolve();
    }
  }
}

async function getAllQueues() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  const value = data[STORAGE_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function setAllQueues(queues) {
  await chrome.storage.local.set({ [STORAGE_KEY]: queues });
}

async function getQueue(windowId) {
  const queues = await getAllQueues();
  const queue = queues[String(windowId)];
  return Array.isArray(queue) ? queue : [];
}

async function updateQueue(windowId, updater) {
  return locked(async () => {
    const key = String(windowId);
    const queues = await getAllQueues();
    const current = Array.isArray(queues[key]) ? queues[key] : [];
    const next = unique(await updater(current));

    if (next.length > 0) {
      queues[key] = next;
    } else {
      delete queues[key];
    }

    await setAllQueues(queues);
    return next;
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function cannotObserveModifiers(tab) {
  return !tab.url || /^(chrome|edge|brave|vivaldi|opera|about):\/\//.test(tab.url);
}

async function ensureModifierObserver(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["modifiers.js"],
    });
  } catch (e) {
    // Chrome blocks script injection on chrome:// pages and some internal pages.
  }
}

async function cleanQueue(windowId, queue) {
  const checks = await Promise.allSettled(queue.map((id) => chrome.tabs.get(id)));
  const valid = [];

  checks.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value.windowId === windowId) {
      valid.push(queue[index]);
    }
  });

  return unique(valid);
}

async function buildCycleSnapshot(windowId, activeId) {
  let queue = await cleanQueue(windowId, await getQueue(windowId));

  queue = unique(queue.filter((id) => id !== activeId));
  if (activeId != null) {
    queue.push(activeId);
  }

  return queue;
}

async function touchTab(windowId, tabId) {
  if (tabId == null) return;

  await updateQueue(windowId, async (queue) => {
    queue = await cleanQueue(windowId, queue);
    return [...queue.filter((id) => id !== tabId), tabId];
  });
}

async function removeTab(windowId, tabId) {
  await updateQueue(windowId, (queue) => queue.filter((id) => id !== tabId));
}

async function getTabTitle(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.title || "(no title)";
  } catch {
    return "[closed]";
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title,
    message: String(message).slice(0, 1000),
  });
}

class CycleSession {
  constructor(windowId, snapshot, activeId) {
    this.windowId = windowId;
    this.snapshot = snapshot;
    this.cursor = snapshot.indexOf(activeId);
    this.fromId = activeId;
    this.suppressTabId = null;
    this.lastCommandAt = 0;
  }

  pick(step, activeId) {
    if (this.snapshot.length < 2) {
      return null;
    }

    this.sync(activeId);
    this.cursor = mod(this.cursor + step, this.snapshot.length);
    return this.snapshot[this.cursor];
  }

  sync(tabId) {
    const index = this.snapshot.indexOf(tabId);
    if (index !== -1) {
      this.cursor = index;
    }
  }

  suppress(tabId) {
    this.suppressTabId = tabId;
  }

  consumeSuppression(tabId) {
    if (this.suppressTabId !== tabId) {
      return false;
    }

    this.suppressTabId = null;
    return true;
  }

  async commit() {
    const tabs = await chrome.tabs.query({ active: true, windowId: this.windowId });
    const finalId = tabs[0] ? tabs[0].id : null;
    const fromId = this.fromId;

    await updateQueue(this.windowId, async (queue) => {
      queue = await cleanQueue(this.windowId, queue);

      const next = queue.filter((id) => id !== finalId && id !== fromId);
      if (fromId != null && fromId !== finalId) {
        next.push(fromId);
      }
      if (finalId != null) {
        next.push(finalId);
      }

      return next;
    });
  }
}

async function getOrStartCycle(windowId, activeId) {
  let cycle = cycleByWindow.get(windowId);
  if (cycle) {
    if (!cycle.snapshot.includes(activeId)) {
      cycleByWindow.delete(windowId);
      await cycle.commit();
      cycle = null;
    }
  }

  if (cycle) {
    return cycle;
  }

  const snapshot = await buildCycleSnapshot(windowId, activeId);
  if (snapshot.length < 2) {
    return null;
  }

  cycle = new CycleSession(windowId, snapshot, activeId);
  cycleByWindow.set(windowId, cycle);
  return cycle;
}

async function handleSwitch(step) {
  const activeTab = await getActiveTab();
  if (!activeTab) return;

  const existingCycle = cycleByWindow.get(activeTab.windowId);
  if (existingCycle && existingCycle.suppressTabId === null) {
    const commandGap = Date.now() - existingCycle.lastCommandAt;
    const modifiersHeld = modifiersHeldByWindow.get(activeTab.windowId) === true;
    if (!modifiersHeld || (cannotObserveModifiers(activeTab) && commandGap > SAME_HOLD_COMMAND_GAP_MS)) {
      await commitCycle(activeTab.windowId);
    }
  }

  modifiersHeldByWindow.set(activeTab.windowId, true);

  const cycle = await getOrStartCycle(activeTab.windowId, activeTab.id);
  if (!cycle) {
    return;
  }

  cycle.lastCommandAt = Date.now();

  const targetId = cycle.pick(step, activeTab.id);
  if (targetId == null || targetId === activeTab.id) {
    return;
  }

  cycle.suppress(targetId);

  try {
    const tab = await chrome.tabs.update(targetId, { active: true });
    await ensureModifierObserver(tab.id);
  } catch (error) {
    cycle.suppressTabId = null;
    cycle.snapshot = cycle.snapshot.filter((id) => id !== targetId);
    console.warn("[TabQueue] failed to activate tab", targetId, error);
  }
}

async function handleShowQueue() {
  const activeTab = await getActiveTab();
  if (!activeTab) return;

  await commitCycle(activeTab.windowId);

  const queue = await buildCycleSnapshot(activeTab.windowId, activeTab.id);
  if (queue.length === 0) {
    notify("Tab Queue", "Queue is empty.");
    return;
  }

  const titles = await Promise.all([...queue].reverse().map(getTabTitle));
  notify("Tab Queue", titles.map((title, index) => `${index + 1}. ${title}`).join("\n"));
}

async function handleClearQueue() {
  const activeTab = await getActiveTab();
  if (!activeTab) return;

  cycleByWindow.delete(activeTab.windowId);
  await updateQueue(activeTab.windowId, () => []);
  notify("Tab Queue", "Queue cleared.");
}

async function commitCycle(windowId) {
  const cycle = cycleByWindow.get(windowId);
  if (!cycle) return;

  cycleByWindow.delete(windowId);
  await cycle.commit();
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "switchBack") {
    handleSwitch(-1).catch(console.error);
  } else if (command === "switchForward") {
    handleSwitch(1).catch(console.error);
  } else if (command === "showQueue") {
    handleShowQueue().catch(console.error);
  } else if (command === "clearQueue") {
    handleClearQueue().catch(console.error);
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  ensureModifierObserver(tabId).catch(console.error);

  const cycle = cycleByWindow.get(windowId);

  if (cycle && cycle.consumeSuppression(tabId)) {
    return;
  }

  if (cycle) {
    cycle.sync(tabId);
    commitCycle(windowId).catch(console.error);
    return;
  }

  touchTab(windowId, tabId).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const windowId = removeInfo.windowId;
  const cycle = cycleByWindow.get(windowId);

  if (cycle) {
    cycle.snapshot = cycle.snapshot.filter((id) => id !== tabId);
    if (cycle.cursor >= cycle.snapshot.length) {
      cycle.cursor = cycle.snapshot.length - 1;
    }
  }

  removeTab(windowId, tabId).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !sender.tab) {
    return;
  }

  if (message.type === "modifiersObserved") {
    modifiersHeldByWindow.set(sender.tab.windowId, true);
    return;
  }

  if (message.type === "modifiersReleased") {
    modifiersHeldByWindow.set(sender.tab.windowId, false);
    commitCycle(sender.tab.windowId).catch(console.error);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  cycleByWindow.delete(windowId);
  modifiersHeldByWindow.delete(windowId);
  updateQueue(windowId, () => []).catch(console.error);
});

async function validateQueues() {
  await locked(async () => {
    const queues = await getAllQueues();
    const cleaned = {};

    for (const [windowId, queue] of Object.entries(queues)) {
      const valid = await cleanQueue(Number(windowId), Array.isArray(queue) ? queue : []);
      if (valid.length > 0) {
        cleaned[windowId] = valid;
      }
    }

    await setAllQueues(cleaned);
  });
}

async function initializeQueues() {
  await validateQueues();
  const activeTabs = await chrome.tabs.query({ active: true });
  await Promise.all(activeTabs.map((tab) => touchTab(tab.windowId, tab.id)));
}

chrome.runtime.onStartup.addListener(() => initializeQueues().catch(console.error));
chrome.runtime.onInstalled.addListener(() => initializeQueues().catch(console.error));
