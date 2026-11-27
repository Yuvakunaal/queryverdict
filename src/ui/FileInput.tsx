import { useId, useRef, useState, type DragEvent, type Ref } from 'react';

export interface FileInputProps {
  readonly label: string;
  readonly accept: string;
  readonly hint: string;
  readonly dropLabel: string;
  readonly disabled?: boolean;
  onFiles(files: File[]): void;
  readonly ref?: Ref<HTMLInputElement>;
}

/**
 * Native file picker with a visible label (the keyboard path) and a drop target as an
 * enhancement (DESIGN_SYSTEM §5). Choosing or dropping files only reports them; nothing is
 * submitted automatically.
 */
export function FileInput({ label, accept, hint, dropLabel, disabled, onFiles, ref }: FileInputProps) {
  const id = useId();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    input.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as { current: HTMLInputElement | null }).current = el;
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) onFiles(files);
  };
  return (
    <div className="file-input">
      <div
        className="drop-zone"
        data-over={over || undefined}
        data-disabled={disabled || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <input
          ref={setRefs}
          id={id}
          type="file"
          multiple
          accept={accept}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = ''; // the same file can be chosen again
            if (files.length) onFiles(files);
          }}
        />
        <span className="drop-label">{dropLabel}</span>
      </div>
      <p id={`${id}-hint`} className="field-hint">
        {hint}
      </p>
    </div>
  );
}
