interface DialogProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}

export function Dialog({ title, children, onClose }: DialogProps): React.JSX.Element {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
