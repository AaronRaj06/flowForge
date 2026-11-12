import * as Dialog from '@radix-ui/react-dialog';
import { X, Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; loading?: boolean };

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'press inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-ink text-white hover:bg-black',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:border-line-strong',
        variant === 'ghost' && 'text-muted hover:text-ink hover:bg-sunken',
        variant === 'danger' && 'border border-line bg-surface text-st-error hover:border-st-error',
        className,
      )}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Label({ children, hint, htmlFor }: { children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="mb-1.5">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-muted">
        {children}
      </label>
      {hint && <p className="mt-0.5 text-[12px] leading-snug text-faint">{hint}</p>}
    </div>
  );
}

const field = 'w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft';

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(field, 'h-8', className)} />;

export const Textarea = ({ className, mono, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) => (
  <textarea {...p} className={cx(field, 'min-h-24 resize-y py-2 leading-relaxed', mono && 'font-mono text-[12px]', className)} />
);

export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx(field, 'h-8 pr-7', className)}>
    {children}
  </select>
);

export function Modal({ open, onOpenChange, title, description, children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-ink/25" />
        <Dialog.Content
          className={cx(
            'dialog-content fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-[0_24px_48px_-12px_rgb(0_0_0/0.18)] focus:outline-none',
            wide ? 'max-w-2xl' : 'max-w-md',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">{title}</Dialog.Title>
              {description && <Dialog.Description className="mt-0.5 text-[13px] text-muted">{description}</Dialog.Description>}
            </div>
            <Dialog.Close className="press -mt-1 -mr-1 rounded-md p-1 text-faint hover:bg-sunken hover:text-ink" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <div className="flex items-stretch gap-1.5">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className={cx(field, 'h-8 bg-sunken', mono && 'font-mono text-[12px]')} />
      <Button size="md" onClick={() => navigator.clipboard.writeText(value)}>
        Copy
      </Button>
    </div>
  );
}

export const StatusDot = ({ status }: { status: string }) => {
  const s = status.toLowerCase();
  const color =
    s === 'success' ? 'bg-st-success' : s === 'error' || s === 'auth_error' ? 'bg-st-error' : s === 'running' ? 'bg-st-running' : 'bg-st-pending';
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', color)} aria-hidden />;
};

export { cx };
