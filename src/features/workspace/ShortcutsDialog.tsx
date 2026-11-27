import type { RefObject } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { shortcuts, type Platform } from './shortcuts';

export interface ShortcutsDialogProps {
  readonly open: boolean;
  onClose(): void;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly platform: Platform;
}

const Keys = ({ keys }: { keys: readonly string[] }) => (
  <span className="keys">
    {keys.map((k, i) => (
      <kbd key={i}>{k}</kbd>
    ))}
  </span>
);

/**
 * Shortcut reference (UI_SPECIFICATION §7): only shortcuts the workspace supports, with this
 * platform's key names, and the visible control each one matches. Escape closes it and focus
 * returns to the button that opened it.
 */
export function ShortcutsDialog({ open, onClose, returnFocus, platform }: ShortcutsDialogProps) {
  return (
    <Dialog open={open} title="Keyboard shortcuts" onClose={onClose} returnFocus={returnFocus} wide>
      <p className="dialog-text muted">Every shortcut has a visible button or control. Browser shortcuts such as zoom and find are left unchanged.</p>
      <table className="data-table shortcut-table">
        <caption className="visually-hidden">Keyboard shortcuts</caption>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Keys</th>
            <th scope="col">Where</th>
          </tr>
        </thead>
        <tbody>
          {shortcuts(platform).map((s) => (
            <tr key={s.action}>
              <th scope="row">{s.action}</th>
              <td>
                <Keys keys={s.keys} />
                {s.alt ? (
                  <>
                    <span className="keys-or"> or </span>
                    <Keys keys={s.alt} />
                  </>
                ) : null}
              </td>
              <td>{s.scope}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dialog-actions">
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}
