import { Check } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { themeOptions, type ThemeName } from '../../lib/themes';

interface ThemePickerDialogProps {
  currentTheme: ThemeName;
  onSelect: (theme: ThemeName) => void;
  onClose: () => void;
}

export function ThemePickerDialog({
  currentTheme,
  onSelect,
  onClose,
}: ThemePickerDialogProps): React.JSX.Element {
  return (
    <Dialog title="Thème" onClose={onClose}>
      <div className="theme-grid">
        {themeOptions.map((theme) => (
          <button
            className={`theme-option${theme.name === currentTheme ? ' active' : ''}`}
            key={theme.name}
            type="button"
            onClick={() => onSelect(theme.name)}
          >
            <span className="theme-swatches" aria-hidden="true">
              {theme.swatches.map((swatch) => (
                <span key={swatch} style={{ background: swatch }} />
              ))}
            </span>
            <span>{theme.label}</span>
            {theme.name === currentTheme ? <Check size={16} /> : null}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
