import type { ButtonHTMLAttributes } from 'react';

// Text button with the app's visual variants. Owns `type="button"` and the
// variant-to-class mapping; all other props (id, disabled, onClick,
// data-*, ...) pass through untouched.
type ButtonVariant = 'default' | 'primary' | 'quiet';

export function Button({ variant = 'default', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const className = [variant !== 'default' ? variant : null, rest.className].filter(Boolean).join(' ') || undefined;
  return <button type={type} {...rest} className={className} />;
}
