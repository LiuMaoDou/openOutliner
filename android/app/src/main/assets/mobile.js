(() => {
  if (window.openOutlinerAndroidCommand) return;
  let composing = false;
  document.addEventListener("compositionstart", () => { composing = true; }, true);
  document.addEventListener("compositionend", () => { composing = false; }, true);
  document.addEventListener("focusout", () => { composing = false; }, true);

  // Indentation, the IME and folding can change the editor width without
  // changing its text. Remeasure the focused title after those layout changes.
  let editor = null;
  let width = 0;
  const resizeEditor = () => {
    if (!editor?.isConnected) return;
    editor.style.height = "auto";
    const style = getComputedStyle(editor);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    editor.style.height = `${Math.ceil(editor.scrollHeight + border)}px`;
  };
  const observer = new ResizeObserver(entries => {
    const nextWidth = entries[0]?.contentRect.width;
    if (nextWidth !== width) {
      width = nextWidth;
      requestAnimationFrame(resizeEditor);
    }
  });
  document.addEventListener("focusin", event => {
    observer.disconnect();
    editor = event.target.matches?.("textarea.nodeTitle") ? event.target : null;
    if (editor) { width = 0; observer.observe(editor); }
  }, true);
  document.addEventListener("input", event => {
    if (event.target === editor) requestAnimationFrame(resizeEditor);
  }, true);

  // Native buttons do not take editor focus. Reuse the site's Tab handling so
  // moves go through its existing persistence, undo and synchronization logic.
  window.openOutlinerAndroidCommand = direction => {
    const input = document.activeElement;
    if (document.querySelector("dialog[open]")) return "请先关闭弹窗或解锁页面";
    if (!(input instanceof HTMLTextAreaElement) || !input.matches(".nodeTitle")) {
      return "请先点选要调整层级的节点标题";
    }
    if (composing) return "请先确认正在输入的文字，再调整缩进";
    if (input.closest("[data-node-id]")?.dataset.nodeId.startsWith("temp-")) {
      return "节点正在保存，请稍后重试";
    }
    // Dismiss inline tag suggestions before Tab; otherwise Tab can select a tag.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const start = input.selectionStart;
    const end = input.selectionEnd;
    setTimeout(() => {
      if (!input.isConnected || document.activeElement !== input) return;
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab", code: "Tab", keyCode: 9, which: 9,
        shiftKey: direction === "outdent", bubbles: true, cancelable: true
      }));
      if (input.isConnected && document.activeElement === input) input.setSelectionRange(start, end);
    }, 0);
    return "";
  };
})();
