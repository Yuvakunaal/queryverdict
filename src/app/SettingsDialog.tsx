import { useRef, type RefObject } from 'react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import type { ThemeChoice } from '../stores/uiPrefsStore';

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export interface SettingsDialogProps {
  open: boolean;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  onClose: () => void;
  /** The control that opened the dialog; focus returns to it on close. */
  returnFocus: RefObject<HTMLElement | null>;
}

/** Session settings (docs/UI_SPECIFICATION.md §7). Preferences last for this session only. */
export function SettingsDialog({ open, theme, onThemeChange, onClose, returnFocus }: SettingsDialogProps) {
  const selected = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} title="Settings" onClose={onClose} initialFocus={selected} returnFocus={returnFocus}>
      <fieldset className="radio-group">
        <legend>Theme</legend>
        {OPTIONS.map((o) => (
          <label key={o.value} className="radio-option">
            <input
              ref={o.value === theme ? selected : undefined}
              type="radio"
              name="theme"
              value={o.value}
              checked={o.value === theme}
              onChange={() => onThemeChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
      <p className="muted">Preferences apply to this browser tab and are not saved.</p>
      <div className="dialog-actions">
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}
