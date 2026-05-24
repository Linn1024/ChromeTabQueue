if (!globalThis.__chromeTabQueueModifiersInstalled) {
  globalThis.__chromeTabQueueModifiersInstalled = true;

  function sendModifierMessage(message) {
    try {
      chrome.runtime.sendMessage(message, function () {
        // Reading lastError prevents noisy console errors when the extension is
        // reloaded while this content script is still attached to a page.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // The extension context can be invalidated after reload/update.
    }
  }

  function updateModifierState(event) {
    if (event.type === "keydown" && event.altKey && event.shiftKey) {
      sendModifierMessage({
        type: "modifiersObserved",
        key: event.key
      });
    }

    if (event.type === "keyup" && (event.key === "Alt" || event.key === "Shift") && !(event.altKey && event.shiftKey)) {
      sendModifierMessage({
        type: "modifiersReleased",
        key: event.key
      });
    }
  }

  window.addEventListener("keydown", updateModifierState, true);
  window.addEventListener("keyup", updateModifierState, true);
}
