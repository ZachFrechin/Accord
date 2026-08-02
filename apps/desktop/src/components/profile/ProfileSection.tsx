/**
 * Profile editor — the "Profil" settings tab. Loads the account's own profile and
 * lets it set a display name, a short bio, and an accent color, with a live preview.
 * (Avatar upload lands in Phase A2.)
 */

import { type ChangeEvent, useEffect, useRef, useState } from "react";

import { ApiError } from "../../api/http";
import { useConnection } from "../../realtime/ConnectionProvider";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { Avatar } from "../messaging/Avatar";
import { Button, Field, Icon, TextArea, Tooltip, useToast } from "../ui";
import "./profile.css";

const IMG_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const DEFAULT_ACCENT = "#3be0a0";
const AVATAR_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Validate + prepare an image for avatar upload. Static images are cover-cropped +
 * resized to a 256px webp (small, fast); gifs are kept as-is to preserve animation
 * (subject to the size cap).
 */
export async function processAvatar(file: File): Promise<{ blob: Blob; mime: string }> {
  if (!AVATAR_MIME.includes(file.type)) {
    throw new Error("Format non supporté (PNG, JPEG, WebP ou GIF).");
  }
  if (file.type === "image/gif") {
    if (file.size > AVATAR_MAX_BYTES) throw new Error("Le GIF dépasse 4 Mo.");
    return { blob: file, mime: file.type };
  }
  const bitmap = await createImageBitmap(file);
  const SIZE = 256;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Traitement de l'image impossible.");
  // Cover-crop centered.
  const scale = Math.max(SIZE / bitmap.width, SIZE / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.9));
  if (!blob) throw new Error("Traitement de l'image impossible.");
  return { blob, mime: "image/webp" };
}

const BANNER_MAX_BYTES = 8 * 1024 * 1024;

/** Prepare a banner: static images are width-capped to 640px webp; gifs kept as-is. */
async function processBanner(file: File): Promise<{ blob: Blob; mime: string }> {
  if (!AVATAR_MIME.includes(file.type)) {
    throw new Error("Format non supporté (PNG, JPEG, WebP ou GIF).");
  }
  if (file.type === "image/gif") {
    if (file.size > BANNER_MAX_BYTES) throw new Error("Le GIF dépasse 8 Mo.");
    return { blob: file, mime: file.type };
  }
  const bitmap = await createImageBitmap(file);
  const MAX_W = 640;
  const scale = Math.min(1, MAX_W / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Traitement de l'image impossible.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.85));
  if (!blob) throw new Error("Traitement de l'image impossible.");
  return { blob, mime: "image/webp" };
}

export function ProfileSection() {
  const { client } = useConnection();
  const account = useInstanceStore((s) => activeInstance(s)?.account ?? null);
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [accent, setAccent] = useState(""); // "" = none (falls back to name-derived hue)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!account) return;
    let alive = true;
    setLoading(true);
    setLoadError(false);
    client
      .getProfile(account.userId)
      .then((p) => {
        if (!alive) return;
        setDisplayName(p.display_name ?? "");
        setBio(p.bio ?? "");
        setAccent(p.accent_color ?? "");
        setAvatarUrl(p.avatar_url);
        setBannerUrl(p.banner_url);
      })
      .catch(() => alive && setLoadError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [client, account]);

  async function onPickAvatar(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const { blob, mime } = await processAvatar(file);
      const ticket = await client.requestAvatarUpload(blob.size);
      const put = await fetch(ticket.upload_url, {
        method: "PUT",
        headers: { "content-type": mime },
        body: blob,
      });
      if (!put.ok) throw new Error("L'envoi a échoué.");
      const p = await client.commitAvatar(ticket.version);
      setAvatarUrl(p.avatar_url);
      toast({ title: "Photo de profil mise à jour" });
    } catch (err) {
      toast({
        title: "Échec du changement de photo",
        description: err instanceof Error ? err.message : "Réessayez.",
      });
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function removeAvatar() {
    try {
      const p = await client.deleteAvatar();
      setAvatarUrl(p.avatar_url);
    } catch {
      toast({ title: "Échec de la suppression" });
    }
  }

  async function onPickBanner(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingBanner(true);
    try {
      const { blob, mime } = await processBanner(file);
      const ticket = await client.requestBannerUpload(blob.size);
      const put = await fetch(ticket.upload_url, {
        method: "PUT",
        headers: { "content-type": mime },
        body: blob,
      });
      if (!put.ok) throw new Error("L'envoi a échoué.");
      const p = await client.commitBanner(ticket.version);
      setBannerUrl(p.banner_url);
      toast({ title: "Bannière mise à jour" });
    } catch (err) {
      toast({
        title: "Échec du changement de bannière",
        description: err instanceof Error ? err.message : "Réessayez.",
      });
    } finally {
      setUploadingBanner(false);
    }
  }

  async function removeBanner() {
    try {
      const p = await client.deleteBanner();
      setBannerUrl(p.banner_url);
    } catch {
      toast({ title: "Échec de la suppression" });
    }
  }

  async function save() {
    setSaving(true);
    try {
      await client.updateProfile({ display_name: displayName, bio, accent_color: accent });
      toast({ title: "Profil enregistré" });
    } catch (e) {
      toast({
        title: "Échec de l'enregistrement",
        description: e instanceof ApiError ? e.message : "Réessayez.",
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="home__hint">Chargement…</p>;
  if (loadError) {
    return (
      <div className="profile__error">
        <p>Impossible de charger votre profil.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (account) {
              setLoadError(false);
              setLoading(true);
              client
                .getProfile(account.userId)
                .then((p) => {
                  setDisplayName(p.display_name ?? "");
                  setBio(p.bio ?? "");
                  setAccent(p.accent_color ?? "");
                })
                .catch(() => setLoadError(true))
                .finally(() => setLoading(false));
            }
          }}
        >
          Réessayer
        </Button>
      </div>
    );
  }

  const shownName = displayName.trim() || account?.username || "?";

  return (
    <div className="profile" style={{ ["--accent" as string]: accent || undefined }}>
      {/* Hidden file inputs (triggered by the floating controls). */}
      <input
        ref={bannerRef}
        type="file"
        accept={IMG_ACCEPT}
        style={{ display: "none" }}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void onPickBanner(e)}
      />
      <input
        ref={fileRef}
        type="file"
        accept={IMG_ACCEPT}
        style={{ display: "none" }}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void onPickAvatar(e)}
      />

      {/* Hero — the profile as others read it, edited in place. */}
      <div className="profile__hero">
        <div className="profile__banner" data-empty={!bannerUrl}>
          {bannerUrl && <img src={bannerUrl} alt="" className="profile__banner-img" />}
          <div className="profile__banner-actions no-drag">
            <Tooltip label={bannerUrl ? "Changer la bannière" : "Ajouter une bannière"}>
              <button
                type="button"
                className="profile__float-btn"
                onClick={() => bannerRef.current?.click()}
                disabled={uploadingBanner}
                aria-label={bannerUrl ? "Changer la bannière" : "Ajouter une bannière"}
              >
                <Icon name="image" size={17} />
              </button>
            </Tooltip>
            {bannerUrl && (
              <Tooltip label="Retirer la bannière">
                <button
                  type="button"
                  className="profile__float-btn"
                  onClick={() => void removeBanner()}
                  disabled={uploadingBanner}
                  aria-label="Retirer la bannière"
                >
                  <Icon name="trash" size={16} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="profile__hero-body">
          <div className="profile__avatar no-drag">
            <div className="profile__avatar-ring">
              <Avatar name={shownName} size={84} src={avatarUrl} />
            </div>
            <Tooltip label={avatarUrl ? "Changer la photo" : "Ajouter une photo"}>
              <button
                type="button"
                className="profile__float-btn profile__avatar-edit"
                onClick={() => fileRef.current?.click()}
                disabled={uploadingAvatar}
                aria-label={avatarUrl ? "Changer la photo de profil" : "Ajouter une photo de profil"}
              >
                <Icon name="camera" size={15} />
              </button>
            </Tooltip>
            {avatarUrl && (
              <Tooltip label="Retirer la photo">
                <button
                  type="button"
                  className="profile__float-btn profile__avatar-remove"
                  onClick={() => void removeAvatar()}
                  disabled={uploadingAvatar}
                  aria-label="Retirer la photo de profil"
                >
                  <Icon name="trash" size={13} />
                </button>
              </Tooltip>
            )}
          </div>

          <div className="profile__hero-id">
            <span className="profile__hero-name">{shownName}</span>
            <span className="profile__hero-handle">@{account?.username}</span>
            {bio.trim() && <p className="profile__hero-bio">{bio.trim()}</p>}
          </div>
        </div>
      </div>

      {/* Details — separate floating cards, not one stacked box. */}
      <div className="profile__cards">
        <section className="profile__card">
          <h3 className="profile__card-title">Identité</h3>
          <Field
            label="Nom d'affichage"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={account ? `@${account.username}` : "Votre nom"}
            hint="Affiché à la place de votre identifiant. Laissez vide pour garder @votre-nom."
          />
          <div className="profile__accent">
            <span className="profile__accent-label">Couleur d'accent</span>
            <input
              type="color"
              className="profile__color"
              value={accent || DEFAULT_ACCENT}
              onChange={(e) => setAccent(e.target.value)}
              aria-label="Couleur d'accent"
            />
            {accent && (
              <Button size="sm" variant="ghost" onClick={() => setAccent("")}>
                Réinitialiser
              </Button>
            )}
          </div>
        </section>

        <section className="profile__card">
          <h3 className="profile__card-title">À propos</h3>
          <TextArea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={4}
            maxLength={300}
            aria-label="À propos"
            placeholder="Quelques mots sur vous…"
          />
          <p className="profile__hint">
            Photo de profil : PNG, JPEG, WebP ou GIF · 4 Mo. Bannière : jusqu'à 8 Mo.
          </p>
        </section>
      </div>

      <div className="profile__save">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? "Enregistrement…" : "Enregistrer les modifications"}
        </Button>
      </div>
    </div>
  );
}
