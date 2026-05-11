import { useLayoutEffect, useRef, useState } from 'react';

interface TooltipProps {
  label: string;
  children: React.ReactNode;
}

interface TooltipPosition {
  left: number;
  top: number;
  ready: boolean;
}

const VIEWPORT_MARGIN = 8;

export function Tooltip({ label, children }: TooltipProps): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<TooltipPosition>({ left: 0, top: 0, ready: false });
  const wrapRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  function show(): void {
    setPos({ left: 0, top: 0, ready: false });
    setVisible(true);
  }

  function hide(): void {
    setVisible(false);
  }

  useLayoutEffect(() => {
    if (!visible) return;
    const triggerEl = wrapRef.current;
    const tooltipEl = tooltipRef.current;
    if (!triggerEl || !tooltipEl) return;

    const trigger = triggerEl.getBoundingClientRect();
    const tooltip = tooltipEl.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const spaceAbove = trigger.top;
    const spaceBelow = viewportH - trigger.bottom;
    const spaceLeft = trigger.left;
    const spaceRight = viewportW - trigger.right;

    let left: number;
    let top: number;

    if (spaceAbove >= tooltip.height + VIEWPORT_MARGIN) {
      left = trigger.left + trigger.width / 2 - tooltip.width / 2;
      top = trigger.top - tooltip.height - VIEWPORT_MARGIN;
    } else if (spaceBelow >= tooltip.height + VIEWPORT_MARGIN) {
      left = trigger.left + trigger.width / 2 - tooltip.width / 2;
      top = trigger.bottom + VIEWPORT_MARGIN;
    } else if (spaceRight >= tooltip.width + VIEWPORT_MARGIN) {
      left = trigger.right + VIEWPORT_MARGIN;
      top = trigger.top + trigger.height / 2 - tooltip.height / 2;
    } else if (spaceLeft >= tooltip.width + VIEWPORT_MARGIN) {
      left = trigger.left - tooltip.width - VIEWPORT_MARGIN;
      top = trigger.top + trigger.height / 2 - tooltip.height / 2;
    } else {
      left = trigger.left + trigger.width / 2 - tooltip.width / 2;
      top = trigger.top - tooltip.height - VIEWPORT_MARGIN;
    }

    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, viewportW - tooltip.width - VIEWPORT_MARGIN),
    );
    top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(top, viewportH - tooltip.height - VIEWPORT_MARGIN),
    );

    setPos({ left, top, ready: true });
  }, [visible]);

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
          ref={tooltipRef}
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.top,
            visibility: pos.ready ? 'visible' : 'hidden',
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
            maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
          }}
          role="tooltip"
        >
          {label}
        </div>
      ) : null}
    </>
  );
}
