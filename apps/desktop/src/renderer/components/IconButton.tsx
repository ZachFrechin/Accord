import { Tooltip } from './Tooltip';

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
    <Tooltip label={label}>
      <button
        className="icon-button"
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}
