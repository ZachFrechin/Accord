import { useState } from "react";
import {
  THEME_BASE_ORDER,
  THEME_BASES,
  type ThemeBaseId,
} from "../theme/themeDocument";
import { baseAccentVars } from "../theme/applyTheme";
import { useThemeStore } from "../stores/useThemeStore";
import {
  Button,
  ColorField,
  Dialog,
  DialogClose,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Popover,
  SegmentedControl,
  Skeleton,
  Slider,
  Switch,
  Tabs,
  TextArea,
  Tooltip,
  useToast,
} from "../components/ui";
import "./DesignGallery.css";

/**
 * DesignGallery — the /design route.
 *
 * Renders the full primitive set once per theme base (five bases). Each base
 * section scopes the accent tokens locally via inline CSS variables, so the same
 * components render tinted for Atelier, Phosphor, Ember, Graphite, and Orchid
 * without touching the global theme. Light/dark follows the active app theme.
 */
export default function DesignGallery() {
  const scheme = useThemeStore((s) =>
    s.document.name === "light" ? "light" : "dark",
  );

  return (
    <div className="gallery">
      <header className="gallery__head">
        <h1>Design system</h1>
        <p className="gallery__lede">
          Every primitive, rendered across the five theme bases. Toggle
          light/dark and density from the titlebar to see tokens react.
        </p>
      </header>

      {THEME_BASE_ORDER.map((baseId) => (
        <BaseSection key={baseId} baseId={baseId} scheme={scheme} />
      ))}
    </div>
  );
}

/** One theme-base column: its label plus the primitive showcase, accent-scoped. */
function BaseSection({
  baseId,
  scheme,
}: {
  baseId: ThemeBaseId;
  scheme: "light" | "dark";
}) {
  const spec = THEME_BASES[baseId];
  // Scope the accent locally; children inherit these vars through the cascade.
  const style = baseAccentVars(baseId, scheme) as React.CSSProperties;

  return (
    <section className="gallery__base" style={style}>
      <div className="gallery__base-head">
        <span
          className="gallery__swatch"
          style={{ background: "var(--accent)" }}
          aria-hidden="true"
        />
        <h2>{spec.label}</h2>
      </div>
      <PrimitiveShowcase />
    </section>
  );
}

/** Renders a representative instance of every primitive. */
function PrimitiveShowcase() {
  const { toast } = useToast();
  const [checked, setChecked] = useState(true);
  const [seg, setSeg] = useState("b");
  const [range, setRange] = useState([48]);
  const [color, setColor] = useState("#5b6cff");

  return (
    <div className="showcase">
      {/* Buttons */}
      <Group title="Buttons">
        <Button variant="primary">Primary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
        <IconButton aria-label="Star">
          <Icon name="star" />
        </IconButton>
      </Group>

      {/* Inputs */}
      <Group title="Inputs">
        <Field label="Display name" placeholder="Ada Lovelace" />
        <Field
          label="Email"
          placeholder="you@example.com"
          error="That address looks off."
        />
        <TextArea label="About" placeholder="A few words…" rows={3} />
        <ColorField label="Accent override" value={color} onChange={setColor} />
      </Group>

      {/* Toggles */}
      <Group title="Toggles">
        <label className="showcase__row">
          <Switch checked={checked} onCheckedChange={setChecked} />
          <span>Notifications</span>
        </label>
        <SegmentedControl
          aria-label="View"
          value={seg}
          onValueChange={(v) => v && setSeg(v)}
          options={[
            { value: "a", label: "List" },
            { value: "b", label: "Grid" },
            { value: "c", label: "Feed" },
          ]}
        />
        <div style={{ width: 200 }}>
          <Slider
            aria-label="Volume"
            value={range}
            onValueChange={setRange}
            max={100}
            step={1}
          />
        </div>
      </Group>

      {/* Overlays */}
      <Group title="Overlays">
        <Tooltip label="Helpful hint">
          <Button variant="ghost">Hover me</Button>
        </Tooltip>
        <Popover trigger={<Button variant="outline">Popover</Button>}>
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <strong>Quick edit</strong>
            <Field label="Nickname" placeholder="…" />
          </div>
        </Popover>
        <Dialog
          trigger={<Button>Open dialog</Button>}
          title="Leave conversation?"
          description="You can rejoin later if you are invited again."
        >
          <div
            style={{
              display: "flex",
              gap: "var(--space-2)",
              justifyContent: "flex-end",
              marginTop: "var(--space-4)",
            }}
          >
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="danger">Leave</Button>
            </DialogClose>
          </div>
        </Dialog>
        <Button
          variant="ghost"
          onClick={() =>
            toast({ title: "Saved", description: "Your changes were stored." })
          }
        >
          Fire toast
        </Button>
      </Group>

      {/* Navigation */}
      <Group title="Tabs">
        <div style={{ width: "100%", maxWidth: 420 }}>
          <Tabs
            aria-label="Example tabs"
            items={[
              { value: "one", label: "Overview", content: <p>Overview panel.</p> },
              { value: "two", label: "Members", content: <p>Members panel.</p> },
              {
                value: "three",
                label: "Settings",
                content: <p>Settings panel.</p>,
              },
            ]}
          />
        </div>
      </Group>

      {/* Feedback / status */}
      <Group title="Feedback">
        <div style={{ display: "grid", gap: "var(--space-2)", width: 220 }}>
          <Skeleton height={14} />
          <Skeleton width="70%" height={14} />
          <Skeleton width={40} height={40} radius="50%" />
        </div>
        <EmptyState
          icon={<Icon name="chat-circle-dots" size={28} />}
          title="Nothing here yet"
          description="Empty states keep line length within the reading measure."
        />
      </Group>
    </div>
  );
}

/** Small labelled cluster wrapper used throughout the showcase. */
function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="showcase__group">
      <h3 className="showcase__group-title">{title}</h3>
      <div className="showcase__group-body">{children}</div>
    </div>
  );
}
