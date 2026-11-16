// A floating panel over the map (health, about, boot error). Not modal: the map stays usable.
// Focus moves in on open and back to the opener on close; Esc inside it closes it.
import { useEffect, useRef, type ReactNode } from 'react';
import { Panel, TextButton } from '../ui';

export interface DialogProps {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}

export function Dialog({ title, onClose, children, className }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      ref={ref}
      className={`sh-dialog float deal ${className ?? ''}`}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onClose) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <Panel title={title} numbered>
        {children}
      </Panel>
      {onClose && (
        <span className="sh-dialog-close">
          <TextButton onClick={onClose} ariaLabel={`Close ${title.toLowerCase()}`}>
            CLOSE
          </TextButton>
        </span>
      )}
    </div>
  );
}
