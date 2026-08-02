/**
 * The Customize panel — a live-preview drawer behind the "Personnaliser" FAB.
 * Mirrors the Clay mockup (presets, mode, accent, background, shape, typography,
 * layout) and adds background image/video + surface transparency + glass blur.
 * Every change applies to :root instantly and persists (customize + theme + layout
 * stores).
 */

import { useEffect, useState, type ChangeEvent } from "react";

import { putBgMedia } from "../../lib/bgStore";
import {
  applyPreset as applySavedPreset,
  deletePreset,
  listPresets,
  savePreset,
  type PresetMeta,
} from "../../lib/customPresets";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useThemeStore } from "../../stores/useThemeStore";
import {
  applyCustomize,
  type BgKind,
  REGIONS,
  useCustomizeStore,
} from "../../stores/useCustomizeStore";
import { Icon, Slider, Switch } from "../ui";

const PRESETS = [
  { id: "fern", name: "Fougère", scheme: "dark", accent: "#3ddc97", bg: "solid", alpha: 1, blur: 0 },
  { id: "paper", name: "Papier", scheme: "light", accent: "#12a67c", bg: "solid", alpha: 1, blur: 0 },
  { id: "midnight", name: "Minuit", scheme: "dark", accent: "#5b8def", bg: "solid", alpha: 1, blur: 0 },
  { id: "neon", name: "Néon", scheme: "dark", accent: "#ff5fa2", bg: "solid", alpha: 1, blur: 0 },
  { id: "glass", name: "Verre", scheme: "dark", accent: "#3ddc97", bg: "aurora", alpha: 0.55, blur: 20 },
  { id: "sunset", name: "Coucher", scheme: "dark", accent: "#f59e4b", bg: "ember", alpha: 0.8, blur: 8 },
  { id: "mono", name: "Mono", scheme: "dark", accent: "#e8f0ec", bg: "solid", alpha: 1, blur: 0 },
] as const;

const ACCENTS = [
  "#3ddc97", "#12a67c", "#5b8def", "#7c8cff", "#b57be6",
  "#ff5fa2", "#f59e4b", "#f5c24b", "#f0616d", "#e8f0ec",
];

// Text colours; "" = theme default. First swatch resets to default.
const TEXT_COLORS = ["", "#e8f0ec", "#ffffff", "#cfe8dd", "#f2e7cf", "#c9d3ff", "#ffd6e7"];

const BACKGROUNDS: { id: BgKind; name: string }[] = [
  { id: "solid", name: "Uni" },
  { id: "aurora", name: "Aurore" },
  { id: "ember", name: "Braise" },
  { id: "mesh", name: "Maille" },
];

export function CustomizePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const c = useCustomizeStore();
  const scheme = useThemeStore((s) => s.document.name);
  const toggleScheme = useThemeStore((s) => s.toggleScheme);
  const resetOverrides = useThemeStore((s) => s.resetOverrides);
  const density = useLayoutStore((s) => s.density);
  const setDensity = useLayoutStore((s) => s.setDensity);
  const asideVisible = useLayoutStore((s) => s.asideVisible);
  const toggleAside = useLayoutStore((s) => s.toggleAside);

  // Personnalisations sauvegardées — hooks AVANT le retour conditionnel
  // (règle des hooks : jamais après un early-return).
  const [presetName, setPresetName] = useState("");
  const [presets, setPresets] = useState<PresetMeta[]>([]);
  const [presetBusy, setPresetBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    void listPresets()
      .then(setPresets)
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const setMode = (target: "light" | "dark") => {
    if (scheme !== target) toggleScheme();
    applyCustomize(useCustomizeStore.getState());
  };

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (scheme !== p.scheme) toggleScheme();
    c.setAccent(p.accent);
    c.setBgKind(p.bg as BgKind);
    c.setAllAlpha(p.alpha);
    c.setBlur(p.blur);
    applyCustomize(useCustomizeStore.getState());
  };

  // Selecting a wallpaper reveals it as frosted glass: if the panels are still
  // fully opaque, dial in a sensible transparency + blur so the change is visible.
  const revealGlass = () => {
    const st = useCustomizeStore.getState();
    const allOpaque = Object.values(st.alpha).every((v) => v > 0.92);
    if (allOpaque) c.setAllAlpha(0.6);
    if (st.blur < 8) c.setBlur(14);
  };
  const pickBg = (kind: BgKind) => {
    c.setBgKind(kind);
    if (kind === "solid") {
      c.setAllAlpha(1);
      c.setBlur(0);
    } else {
      revealGlass();
    }
  };
  const upload = (type: "image" | "video") => async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await putBgMedia(file);
    c.setMedia(type);
    c.bumpMediaRev(); // même type, nouveau fichier → le fond se recharge
    revealGlass();
  };

  // Personnalisations sauvegardées (réglages + fond d'écran) — voir customPresets.
  const doSavePreset = async () => {
    setPresetBusy(true);
    try {
      await savePreset(presetName);
      setPresetName("");
      setPresets(await listPresets());
    } catch {
      /* stockage local indisponible */
    } finally {
      setPresetBusy(false);
    }
  };
  const doApplyPreset = async (id: string) => {
    setPresetBusy(true);
    try {
      await applySavedPreset(id);
    } catch {
      /* préréglage corrompu — on n'écrase rien */
    } finally {
      setPresetBusy(false);
    }
  };
  const doDeletePreset = async (id: string) => {
    setPresetBusy(true);
    try {
      await deletePreset(id);
      setPresets(await listPresets());
    } finally {
      setPresetBusy(false);
    }
  };

  // Slider shows true transparency: 0% = solid, 100% = FULLY transparent
  // (alpha 0 — no surface color at all, the wallpaper shows untouched; the old
  // 0.25 floor left everything faintly darkened at "100%").
  const toTransp = (alpha: number) => Math.round((1 - alpha) * 100);
  const toAlpha = (t: number) => 1 - t / 100;
  // The master reflects the overall glassiness (average of all regions), so it stays
  // representative after a single per-region tweak — not just the chat's value.
  const avgAlpha =
    (c.alpha.rail +
      c.alpha.list +
      c.alpha.main +
      c.alpha.members +
      c.alpha.composer +
      c.alpha.modal +
      (c.alpha.card ?? 1)) /
    7;
  const masterTransp = toTransp(avgAlpha);
  const radiusPx = Math.round(14 * c.radiusScale);

  return (
    <aside className="cz" role="dialog" aria-label="Personnaliser l'apparence">
      <header className="cz__head">
        <span className="cz__title">
          <Icon name="paint-brush" size={20} /> Personnaliser
        </span>
        <button className="cz__close" type="button" aria-label="Fermer" onClick={onClose}>
          <Icon name="x" size={18} />
        </button>
      </header>
      <p className="cz__hint">Aperçu en direct — chaque changement s'applique aussitôt.</p>

      <div className="cz__scroll">
        {/* Presets */}
        <div className="cz__label">Ambiances</div>
        <div className="cz__grid2">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="cz__preset" onClick={() => applyPreset(p)}>
              <span
                className="cz__preset-swatch"
                style={{ background: `linear-gradient(135deg, ${p.accent}, #0b0f0e 80%)` }}
              />
              {p.name}
            </button>
          ))}
        </div>

        {/* Mode */}
        <div className="cz__label">Clair / Sombre</div>
        <div className="cz__seg">
          <button type="button" data-active={scheme === "dark"} onClick={() => setMode("dark")}>
            <Icon name="moon" size={16} /> Sombre
          </button>
          <button type="button" data-active={scheme === "light"} onClick={() => setMode("light")}>
            <Icon name="sun" size={16} /> Clair
          </button>
        </div>

        {/* Accent */}
        <div className="cz__label">Couleur d'accent</div>
        <div className="cz__swatches">
          {ACCENTS.map((hex) => (
            <button
              key={hex}
              type="button"
              className="cz__swatch"
              data-active={c.accent === hex || (!c.accent && hex === "#3ddc97")}
              style={{ background: hex }}
              aria-label={hex}
              onClick={() => c.setAccent(hex)}
            />
          ))}
        </div>

        <div className="cz__label">
          Épaisseur des séparateurs <span className="cz__val">{c.borderWidth ?? 1}px</span>
        </div>
        <Slider
          aria-label="Épaisseur des séparateurs"
          min={0}
          max={4}
          step={1}
          value={[c.borderWidth ?? 1]}
          onValueChange={([v]) => c.setBorderWidth(v)}
        />

        {/* Text colour */}
        <div className="cz__label">Couleur du texte</div>
        <div className="cz__swatches">
          {TEXT_COLORS.map((hex) => (
            <button
              key={hex || "default"}
              type="button"
              className="cz__swatch"
              data-default={hex === ""}
              data-active={c.textColor === hex}
              style={hex ? { background: hex } : undefined}
              aria-label={hex || "Couleur par défaut"}
              title={hex || "Défaut"}
              onClick={() => c.setTextColor(hex)}
            />
          ))}
        </div>

        <div className="cz__label">Couleurs par rôle de texte</div>
        <div className="cz__rolecolors">
          {[
            { label: "Texte principal", value: c.textColor, set: c.setTextColor },
            { label: "Texte secondaire", value: c.text2Color ?? "", set: c.setText2Color },
            { label: "Texte atténué", value: c.text3Color ?? "", set: c.setText3Color },
          ].map((r) => (
            <div key={r.label} className="cz__rolecolor">
              <span className="cz__rolecolor-name">{r.label}</span>
              <input
                type="color"
                value={r.value || "#ffffff"}
                onChange={(e) => r.set(e.target.value)}
                aria-label={r.label}
              />
              {r.value && (
                <button type="button" className="cz__rolecolor-reset" onClick={() => r.set("")}>
                  Défaut
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="cz__label">
          Graisse du texte <span className="cz__val">{c.textWeight ?? 400}</span>
        </div>
        <Slider
          aria-label="Graisse du texte"
          min={300}
          max={700}
          step={100}
          value={[c.textWeight ?? 400]}
          onValueChange={([v]) => c.setTextWeight(v)}
        />
        <div className="cz__label">
          Graisse des titres et du gras <span className="cz__val">{c.headingWeight ?? 700}</span>
        </div>
        <Slider
          aria-label="Graisse des titres"
          min={500}
          max={900}
          step={100}
          value={[c.headingWeight ?? 700]}
          onValueChange={([v]) => c.setHeadingWeight(v)}
        />

        <div className="cz__label">
          Contour du texte <span className="cz__val">{(c.textOutlineWidth ?? 0).toFixed(1)}px</span>
        </div>
        <Slider
          aria-label="Contour du texte"
          min={0}
          max={3}
          step={0.5}
          value={[c.textOutlineWidth ?? 0]}
          onValueChange={([v]) => c.setTextOutlineWidth(v)}
        />
        {(c.textOutlineWidth ?? 0) > 0 && (
          <div className="cz__rolecolor">
            <span className="cz__rolecolor-name">Couleur du contour</span>
            <input
              type="color"
              value={c.textOutlineColor ?? "#000000"}
              onChange={(e) => c.setTextOutlineColor(e.target.value)}
              aria-label="Couleur du contour"
            />
          </div>
        )}

        {/* Background */}
        <div className="cz__label">Fond</div>
        <div className="cz__grid3">
          {BACKGROUNDS.map((b) => (
            <button
              key={b.id}
              type="button"
              className="cz__bg"
              data-active={c.bgKind === b.id}
              data-kind={b.id}
              onClick={() => pickBg(b.id)}
            >
              <span className="cz__bg-preview" data-kind={b.id} />
              {b.name}
            </button>
          ))}
          <label className="cz__bg cz__bg--upload" data-active={c.bgKind === "image"}>
            <input type="file" accept="image/*" hidden onChange={upload("image")} />
            <span className="cz__bg-preview cz__bg-icon"><Icon name="paperclip" size={16} /></span>
            Image
          </label>
          <label className="cz__bg cz__bg--upload" data-active={c.bgKind === "video"}>
            <input type="file" accept="video/*" hidden onChange={upload("video")} />
            <span className="cz__bg-preview cz__bg-icon"><Icon name="video-camera" size={16} /></span>
            Vidéo
          </label>
        </div>
        {c.mediaType && (
          <button className="cz__clear" type="button" onClick={() => c.clearMedia()}>
            Retirer le média
          </button>
        )}

        {/* Transparency — master + per element */}
        <div className="cz__label">
          Transparence (tous) <span className="cz__val">{masterTransp}%</span>
        </div>
        <Slider
          aria-label="Transparence globale"
          min={0}
          max={100}
          step={1}
          value={[masterTransp]}
          onValueChange={([v]) => c.setAllAlpha(toAlpha(v))}
        />
        <div className="cz__label">Transparence par élément</div>
        {REGIONS.map((r) => (
          <div className="cz__mini" key={r.key}>
            <span className="cz__mini-label">
              {r.label} <span className="cz__val">{toTransp(c.alpha[r.key])}%</span>
            </span>
            <Slider
              aria-label={`Transparence ${r.label}`}
              min={0}
              max={100}
              step={1}
              value={[toTransp(c.alpha[r.key])]}
              onValueChange={([v]) => c.setAlphaFor(r.key, toAlpha(v))}
            />
          </div>
        ))}
        <div className="cz__label">
          Flou (verre) <span className="cz__val">{c.blur}px</span>
        </div>
        <Slider
          aria-label="Flou"
          min={0}
          max={30}
          step={1}
          value={[c.blur]}
          onValueChange={([v]) => c.setBlur(v)}
        />

        {/* Glass — one-click looks, accent tint, and the light/grain treatments. */}
        <div className="cz__label">Verre</div>
        <div className="cz__seg">
          {(
            [
              ["none", "Aucun"],
              ["clear", "Clair"],
              ["frosted", "Givré"],
              ["tinted", "Teinté"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" onClick={() => c.applyGlassPreset(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="cz__label">
          Teinte du verre <span className="cz__val">{Math.round(c.glassTint * 100)}%</span>
        </div>
        <Slider
          aria-label="Teinte du verre"
          min={0}
          max={100}
          step={1}
          value={[Math.round(c.glassTint * 100)]}
          onValueChange={([v]) => c.setGlassTint(v / 100)}
        />
        <div className="cz__row">
          <span>Bord lumineux</span>
          <Switch checked={c.glassEdge} onCheckedChange={c.setGlassEdge} />
        </div>
        <div className="cz__row">
          <span>Grain de givre</span>
          <Switch checked={c.glassGrain} onCheckedChange={c.setGlassGrain} />
        </div>

        {/* Shape */}
        <div className="cz__label">
          Rayon des coins <span className="cz__val">{radiusPx}px</span>
        </div>
        <Slider
          aria-label="Rayon"
          min={40}
          max={170}
          step={5}
          value={[Math.round(c.radiusScale * 100)]}
          onValueChange={([v]) => c.setRadius(v / 100)}
        />
        <div className="cz__label">Forme des avatars</div>
        <div className="cz__seg">
          {(["circle", "rounded", "square"] as const).map((s) => (
            <button key={s} type="button" data-active={c.avatarShape === s} onClick={() => c.setAvatarShape(s)}>
              {s === "circle" ? "Cercle" : s === "rounded" ? "Arrondi" : "Carré"}
            </button>
          ))}
        </div>
        <div className="cz__label">Style des messages</div>
        <div className="cz__seg">
          <button type="button" data-active={c.msgStyle === "bubbles"} onClick={() => c.setMsgStyle("bubbles")}>
            Bulles
          </button>
          <button type="button" data-active={c.msgStyle === "flat"} onClick={() => c.setMsgStyle("flat")}>
            Plat
          </button>
        </div>

        {/* Typography */}
        <div className="cz__label">Typographie</div>
        <div className="cz__grid2">
          {(
            [
              ["manrope", "Manrope"],
              ["grotesk", "Grotesk"],
              ["plex", "Plex Sans"],
              ["mono", "Mono"],
            ] as const
          ).map(([f, label]) => (
            <button key={f} type="button" className="cz__font" data-active={c.font === f} onClick={() => c.setFont(f)}>
              {label}
            </button>
          ))}
        </div>
        <div className="cz__label">
          Taille de base <span className="cz__val">{c.baseSize}px</span>
        </div>
        <Slider
          aria-label="Taille"
          min={13}
          max={19}
          step={1}
          value={[c.baseSize]}
          onValueChange={([v]) => c.setBaseSize(v)}
        />

        {/* Layout */}
        <div className="cz__label">Densité</div>
        <div className="cz__seg">
          {(
            [
              ["compact", "Compact"],
              ["cozy", "Confort"],
              ["comfortable", "Spacieux"],
            ] as const
          ).map(([d, label]) => (
            <button key={d} type="button" data-active={density === d} onClick={() => setDensity(d)}>
              {label}
            </button>
          ))}
        </div>
        <div className="cz__label">Côté de la navigation</div>
        <div className="cz__seg">
          <button type="button" data-active={c.navSide === "left"} onClick={() => c.setNavSide("left")}>
            Gauche
          </button>
          <button type="button" data-active={c.navSide === "right"} onClick={() => c.setNavSide("right")}>
            Droite
          </button>
        </div>
        <div className="cz__row">
          <span>Afficher le panneau des membres</span>
          <Switch checked={asideVisible} onCheckedChange={() => toggleAside()} />
        </div>

        <div className="cz__label">Personnalisations sauvegardées</div>
        <div className="cz__saved-save">
          <input
            type="text"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="Nom (ex. « Setup anime »)"
            aria-label="Nom de la personnalisation"
            maxLength={40}
          />
          <button
            type="button"
            className="cz__saved-save-btn"
            disabled={presetBusy}
            onClick={() => void doSavePreset()}
          >
            Sauvegarder
          </button>
        </div>
        {presets.length === 0 ? (
          <p className="cz__hint">
            Sauvegardez l'apparence actuelle (fond d'écran inclus) pour y revenir plus tard.
          </p>
        ) : (
          <div className="cz__saved-list">
            {presets.map((p) => (
              <div key={p.id} className="cz__saved">
                <div className="cz__saved-id">
                  <span className="cz__saved-name">{p.name}</span>
                  <span className="cz__saved-meta">
                    {new Date(p.createdAt).toLocaleDateString("fr-FR")}
                    {p.hasMedia && " · fond inclus"}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={presetBusy}
                  onClick={() => void doApplyPreset(p.id)}
                >
                  Appliquer
                </button>
                <button
                  type="button"
                  className="cz__saved-del"
                  aria-label={`Supprimer ${p.name}`}
                  disabled={presetBusy}
                  onClick={() => void doDeletePreset(p.id)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="cz__foot">
        <button
          className="cz__reset"
          type="button"
          onClick={() => {
            c.reset();
            resetOverrides();
          }}
        >
          Réinitialiser
        </button>
        <button className="cz__done" type="button" onClick={onClose}>
          Terminé
        </button>
      </footer>
    </aside>
  );
}
