import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Element focused when the dialog opens (defaults to the first focusable element). */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Element that receives focus when the dialog closes: normally the control that opened it.
   * Required because a pointer click does not focus buttons in Safari/WebKit, so "whatever was
   * focused before opening" can be <body>.
   */
  returnFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * Modal dialog on the native <dialog> element (docs/DESIGN_SYSTEM.md §5): accessible name from
 * the title, focus containment and Escape from the platform, explicit initial focus, and focus
 * returned to `returnFocus` on every kind of dismissal (button, Escape, pointer).
 */
export function Dialog({ open, title, onClose, initialFocus, returnFocus, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocus?.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocus]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      returnFocus.current?.focus();
      onClose();
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose, returnFocus]);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId}>
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {open ? children : null}
      </div>
    </dialog>
  );
}
