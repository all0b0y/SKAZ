import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  /** Visually hide the label (it stays the accessible name). */
  hideLabel?: boolean;
  hint?: ReactNode;
  /** Error text shown in place, linked to the input and announced. */
  error?: string | null;
  leading?: 'search' | 'folder';
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hideLabel = false, hint, error, leading, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? `${auto}-input`;
  const hintId = hint ? `${auto}-hint` : undefined;
  const errorId = error ? `${auto}-error` : undefined;
  const described = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`kb-field${error ? ' has-error' : ''}${className ? ` ${className}` : ''}`}>
      <label htmlFor={inputId} className={hideLabel ? 'kb-visually-hidden' : 'kb-field__label'}>{label}</label>
      <div className="kb-field__box">
        {leading && <Icon name={leading} size={14} />}
        <input
          ref={ref}
          id={inputId}
          className="kb-field__input"
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          {...rest}
        />
      </div>
      {hint && <div id={hintId} className="kb-field__hint">{hint}</div>}
      {error && <div id={errorId} className="kb-field__error" role="alert">{error}</div>}
    </div>
  );
});
