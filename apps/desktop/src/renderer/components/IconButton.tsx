interface IconButtonProps {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}

export function IconButton({
  label,
  children,
  disabled,
  onClick,
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={label}
      data-tooltip={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
