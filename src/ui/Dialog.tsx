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
  /** Wider layout for content such as file lists. */
  wide?: boolean;
  /** Open with focus on the title, so long content is read (and shown) from the top. */
  focusTitle?: boolean;
  children: ReactNode;
}

/**
 * Modal dialog on the native <dialog> element (docs/DESIGN_SYSTEM.md §5): accessible name from
 * the title, focus containment and Escape from the platform, explicit initial focus, and focus
 * returned to `returnFocus` on every kind of dismissal (button, Escape, pointer).
 */
export function Dialog({ open, title, onClose, initialFocus, returnFocus, wide, focusTitle, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      if (focusTitle) titleRef.current?.focus();
      else initialFocus?.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocus, focusTitle]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Escape fires `cancel` synchronously; the `close` event that follows is queued as a task.
    // Reporting the dismissal at `cancel` keeps the owner's open state in step with the native
    // dialog, so a control activated in between (for example, opening another dialog at once)
    // sees it closed (found in M12 testing).
    const handleCancel = (e: Event) => {
      // `cancel` also bubbles from a file input whose picker was dismissed: that is not a dismissal of this dialog.
      if (e.target !== dialog) return;
      returnFocus.current?.focus();
      onClose();
    };
    const handleClose = () => {
      // A close event that fires after the dialog was opened again is stale: it must not close
      // the new open or move focus.
      if (dialog.open) return;
      returnFocus.current?.focus();
      onClose();
    };
    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('close', handleClose);
    };
  }, [onClose, returnFocus]);

  return (
    <dialog ref={ref} className="dialog" data-size={wide ? 'wide' : undefined} aria-labelledby={titleId}>
      <div className="dialog-body">
        <h2 id={titleId} ref={titleRef} className="dialog-title" {...(focusTitle ? { tabIndex: -1 } : {})}>
          {title}
        </h2>
        {open ? children : null}
      </div>
    </dialog>
  );
}
