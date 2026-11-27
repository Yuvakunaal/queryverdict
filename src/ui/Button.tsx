import type { ButtonHTMLAttributes, Ref } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive' | 'quiet-destructive';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  ref?: Ref<HTMLButtonElement>;
}

/** Button variants from docs/DESIGN_SYSTEM.md §5. Defaults to type="button" (never submits). */
export function Button({ variant = 'secondary', type = 'button', className, ref, ...rest }: ButtonProps) {
  return <button ref={ref} type={type} data-variant={variant} className={className ? `btn ${className}` : 'btn'} {...rest} />;
}
