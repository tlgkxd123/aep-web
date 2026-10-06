import { useId, type ReactNode } from "react";
import { Icon } from "./icons.tsx";
import "./projectOps.css";

/** A modal window with AE's title bar; Escape cancels. */
export function Dialog({
  title,
  className = "",
  role = "dialog",
  onCancel,
  children,
}: {
  title: string;
  className?: string;
  role?: "dialog" | "alertdialog";
  onCancel: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="modal-backdrop">
      <div
        className={`ae-window ${className}`}
        role={role}
        aria-modal="true"
        aria-labelledby={id}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onCancel();
        }}
      >
        <div className="ae-window-title">
          <h2 id={id}>{title}</h2>
          <button type="button" className="ae-window-close" aria-label="Close" onClick={onCancel}>
            <Icon name="close" size={10} />
          </button>
        </div>
        <div className="ae-window-body">{children}</div>
      </div>
    </div>
  );
}

export interface AlertAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/** AE's warning box: an icon, the message and a row of buttons; the primary one has focus. */
export function AlertDialog({ title = "After Effects", message, actions, onCancel }: { title?: string; message: ReactNode; actions: AlertAction[]; onCancel: () => void }) {
  return (
    <Dialog title={title} className="ae-alert" role="alertdialog" onCancel={onCancel}>
      <div className="ae-alert-body">
        <Icon name="warning" size={28} className="ae-alert-icon" />
        <div className="ae-alert-text">{message}</div>
      </div>
      <div className="dialog-actions">
        {actions.map((a) => (
          <button key={a.label} type="button" className={a.primary ? "ae-primary" : "ae-secondary"} autoFocus={a.primary} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
