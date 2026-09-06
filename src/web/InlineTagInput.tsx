import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import type { Tag } from "./api";
import { consumeInlineTag, findInlineTag, inlineTagOptions, type InlineTagTrigger } from "./inlineTags";

function caretBounds(input: HTMLTextAreaElement) {
  const bounds = input.getBoundingClientRect();
  const style = window.getComputedStyle(input);
  const mirror = document.createElement("div");
  for (const property of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "padding", "border", "box-sizing", "text-indent", "tab-size"]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", pointerEvents: "none",
    whiteSpace: "pre-wrap", overflowWrap: "break-word",
    width: `${bounds.width}px`, left: `${bounds.left}px`, top: `${bounds.top - input.scrollTop}px`
  });
  mirror.textContent = input.value.slice(0, input.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = input.value.slice(input.selectionStart) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const position = marker.getBoundingClientRect();
  mirror.remove();
  return { left: position.left, top: position.top, bottom: position.top + (parseFloat(style.lineHeight) || 24) };
}

export function useInlineTagInput({ nodeId, value, inputRef, tags, onAdd, onApply, onError }: {
  nodeId: string;
  value: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  tags: Tag[];
  onAdd: (name: string) => Promise<void>;
  onApply: (value: string, selectionStart: number) => void;
  onError: (error: unknown) => void;
}) {
  const [trigger, setTrigger] = useState<InlineTagTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const composing = useRef(false);
  const suppressed = useRef("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const options = useMemo(() => inlineTagOptions(tags, trigger?.query ?? ""), [tags, trigger?.query]);
  const selectedIndex = Math.min(activeIndex, Math.max(0, options.length - 1));
  const listId = `inline-tags-${nodeId}`;

  const close = () => setTrigger(null);
  const refresh = (input: HTMLTextAreaElement) => {
    valueRef.current = input.value;
    if (composing.current || document.activeElement !== input) return;
    const next = findInlineTag(input.value, input.selectionStart, input.selectionEnd);
    if (suppressed.current === `${input.value}:${input.selectionStart}`) return;
    suppressed.current = "";
    if (trigger?.start !== next?.start || trigger?.end !== next?.end || trigger?.query !== next?.query) setActiveIndex(0);
    setTrigger(current => current?.start === next?.start && current?.end === next?.end && current?.query === next?.query ? current : next);
  };

  useLayoutEffect(() => {
    if (!trigger) return;
    const updatePosition = () => {
      const input = inputRef.current;
      if (!input) return;
      const bounds = input.getBoundingClientRect();
      if (bounds.bottom < 0 || bounds.top > window.innerHeight) { setTrigger(null); return; }
      const caret = caretBounds(input);
      const width = Math.min(280, window.innerWidth - 24);
      const below = window.innerHeight - caret.bottom - 12;
      const above = caret.top - 12;
      const desiredHeight = Math.max(76, options.length * 34 + 42);
      const useBelow = below >= desiredHeight || below >= above;
      const height = Math.max(60, Math.min(desiredHeight, useBelow ? below : above));
      setPosition({
        left: Math.max(12, Math.min(caret.left, window.innerWidth - width - 12)),
        top: Math.max(8, useBelow ? caret.bottom + 6 : caret.top - height - 6),
        width, maxHeight: height
      });
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      updatePosition();
    };
    updatePosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("resize", updatePosition);
    };
  }, [trigger, options.length, inputRef]);

  useLayoutEffect(() => {
    if (!trigger) return;
    document.getElementById(`${listId}-${selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [trigger, listId, selectedIndex]);

  const choose = (name: string) => {
    const input = inputRef.current;
    if (!trigger || !input || composing.current) return;
    const current = findInlineTag(input.value, input.selectionStart, input.selectionEnd);
    if (!current || current.start !== trigger.start) { close(); return; }
    const consumed = consumeInlineTag(input.value, current);
    close();
    valueRef.current = consumed.value;
    onApply(consumed.value, consumed.selectionStart);
    void onAdd(name).catch(error => {
      // Keep the command recoverable if attaching the tag fails, including
      // text typed after confirmation. Never roll back the whole title.
      const latest = valueRef.current;
      const at = Math.min(consumed.selectionStart, latest.length);
      const restored = latest.slice(0, at) + consumed.removed + latest.slice(at);
      valueRef.current = restored;
      onApply(restored, at + consumed.removed.length);
      onError(error);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!trigger || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      suppressed.current = `${event.currentTarget.value}:${event.currentTarget.selectionStart}`;
      close();
      return true;
    }
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (options.length) setActiveIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && options[selectedIndex]) {
      event.preventDefault();
      event.stopPropagation();
      choose(options[selectedIndex].name);
      return true;
    }
    return false;
  };

  return {
    composing, refresh, close, onKeyDown,
    inputProps: {
      "aria-autocomplete": "list" as const,
      "aria-haspopup": "listbox" as const,
      "aria-controls": trigger ? listId : undefined,
      "aria-activedescendant": trigger && options.length ? `${listId}-${selectedIndex}` : undefined
    },
    menu: trigger ? createPortal(
      <div className="tagSuggestionList inlineTagSuggestions" id={listId} ref={menuRef} style={position} role="listbox" aria-label="标签建议"
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
        onClick={event => event.stopPropagation()}>
        {options.map((option, index) => <button
          className="tagSuggestionItem" type="button" role="option" tabIndex={-1}
          id={`${listId}-${index}`} key={option.name} aria-selected={index === selectedIndex}
          onClick={() => choose(option.name)}>
          {option.create ? <Plus size={14} aria-hidden="true" /> : <span className="tagSuggestionDot" style={{ backgroundColor: option.color }} aria-hidden="true" />}
          <span className="tagSuggestionName">{option.create ? "创建 " : ""}#{option.name}</span>
        </button>)}
        <div className="inlineTagHint">{options.length ? "↑↓ 选择 · Enter / Tab 确认 · Esc 取消" : "继续输入以创建标签"}</div>
      </div>, document.body
    ) : null
  };
}
