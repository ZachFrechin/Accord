/**
 * Apparence — la personnalisation, réduite à ce qui a du sens sur un téléphone.
 *
 * Le bureau propose beaucoup (transparences par région, flou, grain, largeur des
 * panneaux) parce qu'il a de la place et une souris. Ici on garde ce qui change
 * vraiment le ressenti à l'écran : la couleur d'accent, le thème, la taille du
 * texte, la forme des avatars et le fond. Les réglages passent par le même store
 * que le bureau, donc ils s'appliquent en direct.
 */

import { useRef } from "react";

import { putBgMedia } from "@accord/core/lib/bgStore";
import { Icon } from "@accord/core/ui/Icon";
import { useCustomizeStore } from "@accord/core/stores/useCustomizeStore";
import { useThemeStore } from "@accord/core/stores/useThemeStore";

/** Palette d'accents — les mêmes teintes que sur le bureau. */
const ACCENTS = [
  "#3ddc97", "#12a67c", "#5b8def", "#7c8cff", "#b57be6",
  "#ff5fa2", "#f59e4b", "#f5c24b", "#f0616d", "#e8f0ec",
];

export function Appearance() {
  const c = useCustomizeStore();
  const scheme = useThemeStore((s) => s.document.name);
  const toggleScheme = useThemeStore((s) => s.toggleScheme);
  const bgRef = useRef<HTMLInputElement>(null);

  return (
    <div className="page">
      <div className="card">
        <span className="field__label">Thème</span>
        <div className="seg seg--inline">
          {(["dark", "light"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={scheme === mode}
              onClick={() => scheme !== mode && toggleScheme()}
            >
              {mode === "dark" ? "Sombre" : "Clair"}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <span className="field__label">Couleur d'accent</span>
        <div className="swatches">
          {ACCENTS.map((hex) => (
            <button
              key={hex}
              type="button"
              className="swatch"
              data-active={c.accent === hex}
              style={{ background: hex }}
              aria-label={`Accent ${hex}`}
              onClick={() => c.setAccent(hex)}
            />
          ))}
          <button
            type="button"
            className="swatch swatch--reset"
            aria-label="Accent par défaut"
            onClick={() => c.setAccent("")}
          >
            A
          </button>
        </div>
      </div>

      <div className="card">
        <span className="field__label">Taille du texte — {c.baseSize} px</span>
        <input
          type="range"
          min={14}
          max={20}
          step={1}
          value={c.baseSize}
          onChange={(e) => c.setBaseSize(Number(e.target.value))}
          aria-label="Taille du texte"
        />
      </div>

      <div className="card">
        <span className="field__label">Forme des avatars</span>
        <div className="seg seg--inline">
          {([
            ["circle", "Rond"],
            ["rounded", "Arrondi"],
            ["square", "Carré"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-active={c.avatarShape === value}
              onClick={() => c.setAvatarShape(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <span className="field__label">Fond d'écran</span>
        <div className="seg seg--inline">
          {([
            ["solid", "Uni"],
            ["aurora", "Aurore"],
            ["ember", "Braise"],
            ["mesh", "Maille"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-active={c.bgKind === value}
              onClick={() => c.setBgKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="btn btn--quiet" type="button" onClick={() => bgRef.current?.click()}>
          <Icon name="image" size={18} /> Image ou vidéo
        </button>
        {c.mediaType && (
          <button className="btn btn--quiet" type="button" onClick={() => c.clearMedia()}>
            Retirer le fond
          </button>
        )}
        <input
          ref={bgRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            // Le type du fichier décide : une vidéo est lue en boucle, une image
            // est posée telle quelle.
            const kind = f.type.startsWith("video/") ? "video" : "image";
            void putBgMedia(f).then(() => {
              c.setMedia(kind);
              c.bumpMediaRev();
            });
          }}
        />
      </div>

      <div className="card">
        <span className="field__label">
          Transparence de l'interface — {Math.round((1 - c.alpha.main) * 100)} %
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round((1 - c.alpha.main) * 100)}
          onChange={(e) => c.setAllAlpha(1 - Number(e.target.value) / 100)}
          aria-label="Transparence de l'interface"
        />
        <span className="field__label">
          Transparence des conteneurs — {Math.round((1 - (c.alpha.card ?? 1)) * 100)} %
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round((1 - (c.alpha.card ?? 1)) * 100)}
          onChange={(e) => c.setAlphaFor("card", 1 - Number(e.target.value) / 100)}
          aria-label="Transparence des conteneurs"
        />
        <span className="field__label">Flou — {c.blur} px</span>
        <input
          type="range"
          min={0}
          max={24}
          step={1}
          value={c.blur}
          onChange={(e) => c.setBlur(Number(e.target.value))}
          aria-label="Flou"
        />
        <span className="field__label">Épaisseur des séparateurs — {c.borderWidth ?? 1} px</span>
        <input
          type="range"
          min={0}
          max={4}
          step={1}
          value={c.borderWidth ?? 1}
          onChange={(e) => c.setBorderWidth(Number(e.target.value))}
          aria-label="Épaisseur des séparateurs"
        />
      </div>

      <div className="card">
        <span className="field__label">Couleurs du texte</span>
        {([
          ["Principal", c.textColor, c.setTextColor],
          ["Secondaire", c.text2Color ?? "", c.setText2Color],
          ["Atténué", c.text3Color ?? "", c.setText3Color],
        ] as const).map(([label, value, set]) => (
          <div key={label} className="row">
            <span className="row__label">{label}</span>
            <span className="row__value">
              <input
                type="color"
                className="color"
                value={value || "#ffffff"}
                onChange={(e) => set(e.target.value)}
                aria-label={`Couleur ${label}`}
              />
              {value && (
                <button type="button" className="btn btn--quiet btn--tiny" onClick={() => set("")}>
                  Défaut
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <span className="field__label">
          Contour du texte — {(c.textOutlineWidth ?? 0).toFixed(1)} px
        </span>
        <input
          type="range"
          min={0}
          max={3}
          step={0.5}
          value={c.textOutlineWidth ?? 0}
          onChange={(e) => c.setTextOutlineWidth(Number(e.target.value))}
          aria-label="Contour du texte"
        />
        {(c.textOutlineWidth ?? 0) > 0 && (
          <div className="row">
            <span className="row__label">Couleur du contour</span>
            <input
              type="color"
              className="color"
              value={c.textOutlineColor ?? "#000000"}
              onChange={(e) => c.setTextOutlineColor(e.target.value)}
              aria-label="Couleur du contour"
            />
          </div>
        )}
        <span className="field__label">Graisse du texte — {c.textWeight ?? 400}</span>
        <input
          type="range"
          min={300}
          max={700}
          step={100}
          value={c.textWeight ?? 400}
          onChange={(e) => c.setTextWeight(Number(e.target.value))}
          aria-label="Graisse du texte"
        />
      </div>

      <button className="btn btn--quiet" type="button" onClick={() => c.reset()}>
        Réinitialiser l'apparence
      </button>
    </div>
  );
}
