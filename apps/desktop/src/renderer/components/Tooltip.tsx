import { useRef, useState } from 'react';

interface TooltipProps {
  label: string;
  children: React.ReactNode;
}

export function Tooltip({ label, children }: TooltipProps): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);

  function show(): void {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: rect.left + rect.width / 2,
      top: rect.top - 8,
    });
    setVisible(true);
  }

  function hide(): void {
    setVisible(false);
  }

  return (
    <>
      <div
        ref={wrapRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        style={{ display: 'inline-flex' }}
      >
        {children}
      </div>
      {visible ? (
        <div
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            transform: 'translate(-50%, -100%)',
            zIndex: 9999,
            pointerEvents: 'none',
            padding: '7px 9px',
            border: '1px solid var(--border-dialog)',
            borderRadius: 8,
            color: 'var(--text-primary)',
            background: 'var(--bg-popup)',
            boxShadow: 'var(--shadow-md)',
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            animation: 'tooltipIn 140ms ease',
          }}
          role="tooltip"
        >
          {label}
        </div>
      ) : null}
    </>
  );
}
