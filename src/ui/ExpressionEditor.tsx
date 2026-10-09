// The expression field: a code editor with syntax colouring, completions,
// auto-indent and bracket pairing. Enter adds a line; Ctrl+Enter, the numpad
// Enter or clicking elsewhere applies the expression; Escape discards the edit.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { complete, tokenize, type Completion, type CompletionResult, type NameSource } from "./expressionSyntax.ts";

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
const CLOSERS = new Set([")", "]", "}", '"', "'", "`"]);
const INDENT = "  ";
const MAX_ITEMS = 12;
/** Matches the 15px line height of .expr-code. */
const LINE_HEIGHT = 15;

export function HighlightedCode({ source }: { source: string }) {
  return (
    <>
      {tokenize(source).map((t, i) => (t.kind === "space" || t.kind === "ident" ? t.text : <span key={i} className={`tok-${t.kind}`}>{t.text}</span>))}
    </>
  );
}

/** Replaces the selection with `text` keeping the browser's undo history where it can. */
function insert(area: HTMLTextAreaElement, text: string, selectFrom?: number, selectTo?: number): void {
  area.focus();
  const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  if (!ok) {
    area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (selectFrom !== undefined) area.setSelectionRange(selectFrom, selectTo ?? selectFrom);
}

export function ExpressionEditor({
  initial,
  names,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  names: NameSource;
  label: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [completion, setCompletion] = useState<CompletionResult & { active: number }>();
  const area = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLPreElement>(null);
  const done = useRef(false);
  const [charWidth, setCharWidth] = useState(6.6);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(initial.length, initial.length);
    const style = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = `${style.fontSize} ${style.fontFamily}`;
      const w = ctx.measureText("0123456789").width / 10;
      if (w > 0) setCharWidth(w);
    }
  }, [initial]);

  const refresh = (value: string, at: number) => {
    const result = complete(value, at, names);
    setCompletion(result ? { ...result, items: result.items.slice(0, MAX_ITEMS), active: 0 } : undefined);
  };

  const finish = (apply: boolean) => {
    if (done.current) return;
    done.current = true;
    if (apply) onCommit(area.current?.value ?? text);
    else onCancel();
  };

  const accept = (item: Completion) => {
    const el = area.current;
    if (!el || !completion) return;
    el.setSelectionRange(completion.from, el.selectionStart);
    const call = item.insert.endsWith("()");
    const word = call ? item.insert.slice(0, -1) : item.insert;
    // A name inside quotes also closes the string when the closing quote is not there yet.
    insert(el, word);
    if (call) {
      const at = el.selectionStart;
      insert(el, ")", at, at);
    }
    setCompletion(undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    const el = e.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = el;
    if (completion) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = completion.items.length;
        setCompletion({ ...completion, active: (completion.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if ((e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.metaKey && e.code !== "NumpadEnter")) && !e.shiftKey) {
        e.preventDefault();
        accept(completion.items[completion.active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCompletion(undefined);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.code === "NumpadEnter")) {
      e.preventDefault();
      finish(true);
      return;
    }
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      refresh(value, start);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart, start))![0];
      const opens = /[{[(]\s*$/.test(value.slice(lineStart, start));
      const closes = /^\s*[}\])]/.test(value.slice(end));
      if (opens && closes) insert(el, `\n${indent}${INDENT}\n${indent}`, start + indent.length + INDENT.length + 1);
      else insert(el, `\n${indent}${opens ? INDENT : ""}`);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      if (start === end && !e.shiftKey) {
        insert(el, INDENT);
        return;
      }
      // Indent or outdent every line the selection touches.
      const block = value.slice(lineStart, end);
      const lines = block.split("\n");
      const next = lines.map((l) => (e.shiftKey ? l.replace(/^( {1,2}|\t)/, "") : INDENT + l)).join("\n");
      el.setSelectionRange(lineStart, end);
      insert(el, next, lineStart, lineStart + next.length);
      return;
    }
    if (e.key === "Backspace" && start === end && start > 0) {
      const open = value[start - 1];
      if (PAIRS[open] && value[start] === PAIRS[open]) {
        e.preventDefault();
        el.setSelectionRange(start - 1, start + 1);
        insert(el, "");
      }
      return;
    }
    if (CLOSERS.has(e.key) && start === end && value[start] === e.key && !(PAIRS[e.key] === e.key && value[start - 1] === "\\")) {
      e.preventDefault();
      el.setSelectionRange(start + 1, start + 1);
      setCaret(start + 1);
      return;
    }
    if (PAIRS[e.key] && !e.ctrlKey && !e.metaKey) {
      const quote = PAIRS[e.key] === e.key;
      // A quote right after a word character is an apostrophe, not the start of a string.
      if (quote && start === end && /[\w$]/.test(value[start - 1] ?? "")) return;
      e.preventDefault();
      const selected = value.slice(start, end);
      insert(el, `${e.key}${selected}${PAIRS[e.key]}`, start + 1, start + 1 + selected.length);
    }
  };

  const lines = text.split("\n");
  const caretLine = text.slice(0, caret).split("\n").length - 1;
  const caretColumn = caret - (text.lastIndexOf("\n", caret - 1) + 1);
  const highlighted = useMemo(() => <HighlightedCode source={`${text}\n`} />, [text]);
  // The list is fixed to the window at the caret, so the Timeline's clipped rows cannot hide it; near the
  // bottom of the window it opens above the line.
  const popup = (() => {
    const box = area.current?.getBoundingClientRect();
    if (!box || !completion) return undefined;
    const left = box.left + 8 + caretColumn * charWidth - (area.current?.scrollLeft ?? 0);
    const lineTop = box.top + 2 + caretLine * LINE_HEIGHT - (area.current?.scrollTop ?? 0);
    const height = completion.items.length * 18 + 6;
    const below = lineTop + LINE_HEIGHT + height < window.innerHeight;
    return { left: Math.min(left, window.innerWidth - 200), top: below ? lineTop + LINE_HEIGHT + 2 : lineTop - height - 2 };
  })();

  return (
    <div className="expr-editor" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <pre ref={mirror} className="expr-code expr-highlight" aria-hidden="true">
        {highlighted}
      </pre>
      <textarea
        ref={area}
        onScroll={(e) => {
          if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
        }}
        className="expr-code expr-input"
        aria-label={label}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        rows={Math.min(16, Math.max(1, lines.length))}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          refresh(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
      />
      {completion && popup && (
        <ul
          className="expr-completions"
          role="listbox"
          aria-label="Completions"
          style={popup}
          onPointerDown={(e) => e.preventDefault()}
        >
          {completion.items.map((item, i) => (
            <li
              key={item.label}
              role="option"
              aria-selected={i === completion.active}
              className={i === completion.active ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(item);
              }}
            >
              <span className="expr-completion-label">{item.label}</span>
              {item.detail && <span className="expr-completion-detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
