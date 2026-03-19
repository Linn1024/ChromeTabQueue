function updateModifierState(event) {
  if (event.altKey && event.shiftKey && (event.key === "Alt" || event.key === "Shift")) {
    chrome.runtime.sendMessage({
      type: "modifiersObserved",
      key: event.key
    });
  }

  if (event.type === "keyup" && (event.key === "Alt" || event.key === "Shift") && !(event.altKey && event.shiftKey)) {
    chrome.runtime.sendMessage({
      type: "modifiersReleased",
      key: event.key
    });
  }
}

window.addEventListener("keydown", updateModifierState, true);
window.addEventListener("keyup", updateModifierState, true);
