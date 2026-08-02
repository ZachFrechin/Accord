/**
 * CommandPalette (⌘K) — jump to a conversation or run an app action from the
 * keyboard. Opened via useUiStore.paletteOpen (a global ⌘K shortcut toggles it).
 * Filters conversations + actions by the query; ↑/↓ move, Enter runs, Esc closes.
 */

import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { MOD } from "./ShortcutsCheatsheet";

import { loadInstanceMlsHistory } from "../../lib/mls/mlsHistory";
import { searchNormalize } from "../../lib/searchText";
import { openConversation, openDmWith } from "../../stores/messagingActions";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { useFriendsStore } from "../../stores/useFriendsStore";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { type DecryptedMessage, useMessagesStore } from "../../stores/useMessagesStore";
import { useThemeStore } from "../../stores/useThemeStore";
import { useUiStore } from "../../stores/useUiStore";
import { Avatar } from "../messaging/Avatar";
import { Icon, type IconName } from "../ui";
import "./palette.css";

/** A ~60-char snippet of a message centered on the (normalized) query match. */
function snippetOf(text: string, qn: string): string {
  if (text.length <= 60) return text;
  const i = Math.max(0, searchNormalize(text).indexOf(qn));
  const start = Math.max(0, i - 20);
  const end = Math.min(text.length, start + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

interface Command {
  id: string;
  label: string;
  hint?: string;
  /** Conversation rows render an avatar; actions render an icon. */
  avatar?: string;
  icon?: IconName;
  run: () => void;
}

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const openCustomize = useUiStore((s) => s.openCustomize);
  const openOnboarding = useUiStore((s) => s.openOnboarding);
  const openShortcuts = useUiStore((s) => s.openShortcuts);
  const conversations = useConversationsStore((s) => s.conversations);
  const titles = useConversationsStore((s) => s.titles);
  const friends = useFriendsStore((s) => s.friends);
  const byConversation = useMessagesStore((s) => s.byConversation);
  const setSearchScrollTo = useUiStore((s) => s.setSearchScrollTo);
  const toggleScheme = useThemeStore((s) => s.toggleScheme);
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions = useMemo<Command[]>(
    () => [
      { id: "a-friends", label: "Amis & nouvelle conversation", icon: "users-three", run: () => navigate("/friends") },
      { id: "a-customize", label: "Personnaliser l'apparence", icon: "paint-brush", run: openCustomize },
      {
        id: "a-security",
        label: "Sécurité · double authentification",
        icon: "lock",
        run: () => navigate("/settings"),
      },
      { id: "a-settings", label: "Réglages", icon: "gear", run: () => navigate("/settings") },
      { id: "a-theme", label: "Basculer le thème", icon: "moon", run: toggleScheme },
      { id: "a-server", label: "Ajouter un serveur", icon: "plus-circle", run: openOnboarding },
      { id: "a-shortcuts", label: "Raccourcis clavier", icon: "sparkle", run: openShortcuts },
    ],
    [openCustomize, openOnboarding, openShortcuts, toggleScheme, navigate],
  );

  const convCommands = useMemo<Command[]>(
    () =>
      conversations.map((c) => {
        const name = titles[c.id] ?? "Conversation";
        return {
          id: c.id,
          label: name,
          hint: c.kind === "group" ? "Groupe" : "Message direct",
          avatar: name,
          run: () => {
            void openConversation(c.id).catch(() => {});
            navigate("/");
          },
        };
      }),
    [conversations, titles, navigate],
  );

  // Accent-insensitive matching everywhere (« reunion » finds « réunion »).
  const ql = searchNormalize(q).trim();
  const convs = ql
    ? convCommands.filter((c) => searchNormalize(c.label).includes(ql))
    : convCommands;
  const acts = ql ? actions.filter((a) => searchNormalize(a.label).includes(ql)) : actions;

  // People (friends) — only when searching; jump opens the DM.
  const people = useMemo<Command[]>(() => {
    if (!ql) return [];
    return friends
      .filter((f) => searchNormalize(f.username).includes(ql))
      .slice(0, 6)
      .map((f) => ({
        id: `p:${f.user_id}`,
        label: f.username,
        hint: "Message direct",
        avatar: f.username,
        run: () => {
          void openDmWith(f.user_id).catch(() => {});
          navigate("/");
        },
      }));
  }, [ql, friends, navigate]);

  // Full-text corpus for message search: EVERY conversation's persisted MLS
  // history (IndexedDB), loaded when the palette opens — not just what this
  // session already displayed. E2EE: all of it stays on-device.
  const instanceId = useInstanceStore(activeInstance)?.id ?? null;
  const [historyCorpus, setHistoryCorpus] = useState<Map<string, DecryptedMessage[]> | null>(
    null,
  );
  useEffect(() => {
    if (!open || !instanceId) {
      setHistoryCorpus(null);
      return;
    }
    let alive = true;
    void loadInstanceMlsHistory(instanceId)
      .then((corpus) => alive && setHistoryCorpus(corpus))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, instanceId]);

  // Messages — client-side over the decrypted corpus (E2EE: the server can't
  // search). Needs ≥2 chars; newest first; jump opens the conversation +
  // scrolls to the hit.
  const messages = useMemo<Command[]>(() => {
    if (ql.length < 2) return [];
    // The in-memory store overlays the disk corpus: it is fresher and also
    // holds the legacy (pre-MLS) rows of opened conversations.
    const corpus = new Map<string, DecryptedMessage[]>(historyCorpus ?? []);
    for (const [convId, msgs] of Object.entries(byConversation)) corpus.set(convId, msgs);
    const hits: { m: DecryptedMessage; convId: string }[] = [];
    for (const [convId, msgs] of corpus) {
      for (const m of msgs) {
        const text = m.deleted ? null : m.content?.text;
        if (!text || !searchNormalize(text).includes(ql)) continue;
        hits.push({ m, convId });
      }
    }
    hits.sort((a, b) => b.m.createdAt.localeCompare(a.m.createdAt));
    return hits.slice(0, 10).map(({ m, convId }) => {
      const title = titles[convId] ?? "Conversation";
      return {
        id: `m:${convId}:${m.id}`,
        label: snippetOf(m.content?.text ?? "", ql),
        hint: title,
        avatar: title,
        run: () => {
          void openConversation(convId).catch(() => {});
          setSearchScrollTo(m.id);
          navigate("/");
        },
      };
    });
  }, [ql, byConversation, historyCorpus, titles, navigate, setSearchScrollTo]);

  const flat = useMemo(
    () => [...convs, ...people, ...messages, ...acts],
    [convs, people, messages, acts],
  );

  // Reset selection on query change / (re)open; focus the input on open.
  useEffect(() => setSel(0), [ql, open]);
  useEffect(() => {
    if (open) {
      setQ("");
      // Radix focuses the content; move focus to the input on the next frame.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const run = (cmd: Command) => {
    setOpen(false);
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (flat.length ? (s + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (flat.length ? (s - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = flat[Math.min(sel, flat.length - 1)];
      if (cmd) run(cmd);
    }
  };

  let idx = -1;
  const row = (cmd: Command) => {
    idx += 1;
    const i = idx;
    const selected = i === Math.min(sel, flat.length - 1);
    return (
      <button
        key={cmd.id}
        type="button"
        role="option"
        aria-selected={selected}
        className="cmdk__row"
        data-selected={selected}
        onMouseMove={() => setSel(i)}
        onClick={() => run(cmd)}
      >
        {cmd.avatar ? (
          <Avatar name={cmd.avatar} size={24} />
        ) : (
          <Icon name={cmd.icon ?? "gear"} size={18} />
        )}
        <span className="cmdk__label">{cmd.label}</span>
        {cmd.hint ? <span className="cmdk__meta">{cmd.hint}</span> : null}
      </button>
    );
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="cmdk__overlay" />
        <RadixDialog.Content className="cmdk" aria-label="Palette de commandes" onKeyDown={onKeyDown}>
          <RadixDialog.Title className="visually-hidden">Palette de commandes</RadixDialog.Title>
          <div className="cmdk__search">
            <Icon name="magnifying-glass" size={18} />
            <input
              ref={inputRef}
              className="cmdk__input"
              placeholder="Rechercher — conversations, personnes, messages…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Rechercher une commande"
            />
            <span className="cmdk__badge">{MOD}K</span>
          </div>

          <div className="cmdk__list" role="listbox" aria-label="Résultats">
            {flat.length === 0 ? (
              <p className="cmdk__empty">Aucun résultat.</p>
            ) : (
              <>
                {convs.length > 0 && <div className="cmdk__group">Conversations</div>}
                {convs.map(row)}
                {people.length > 0 && <div className="cmdk__group">Personnes</div>}
                {people.map(row)}
                {messages.length > 0 && <div className="cmdk__group">Messages</div>}
                {messages.map(row)}
                {acts.length > 0 && <div className="cmdk__group">Actions</div>}
                {acts.map(row)}
              </>
            )}
          </div>

          <div className="cmdk__foot">
            <span>
              <kbd className="cmdk__kbd">↑</kbd>
              <kbd className="cmdk__kbd">↓</kbd> naviguer
            </span>
            <span>
              <kbd className="cmdk__kbd">↵</kbd> ouvrir
            </span>
            <span>
              <kbd className="cmdk__kbd">esc</kbd> fermer
            </span>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
