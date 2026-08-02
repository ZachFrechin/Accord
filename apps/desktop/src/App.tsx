import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/isTauri";
import { openConversation } from "./stores/messagingActions";
import { useCallStore } from "./stores/useCallStore";
import { useConversationsStore } from "./stores/useConversationsStore";
import { useLayoutStore } from "./stores/useLayoutStore";
import { useThemeStore } from "./stores/useThemeStore";
import { useUiStore } from "./stores/useUiStore";
import { applyLayout } from "./layout/applyLayout";
import { useResizable } from "./layout/useResizable";
import { Icon } from "./components/ui/Icon";
import { IconButton } from "./components/ui/IconButton";
import { Tooltip } from "./components/ui/Tooltip";
import { InstanceRail } from "./components/instances/InstanceRail";
import { ConversationList } from "./components/messaging/ConversationList";
import { ConversationDetails } from "./components/messaging/ConversationDetails";
import { FriendsAside } from "./components/friends/FriendsAside";
import { AppBackground } from "./components/AppBackground";
import { CommandPalette } from "./components/palette/CommandPalette";
import { ShortcutsCheatsheet } from "./components/palette/ShortcutsCheatsheet";
import { CallPip } from "./components/call/CallPip";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { TransparencyBanner } from "./components/TransparencyBanner";
import { IncomingCallModal } from "./components/call/IncomingCallModal";
import { CustomizePanel } from "./components/customize/CustomizePanel";
import "./App.css";
import "./components/messaging/messaging.css";
import "./components/customize/customize.css";

/**
 * App — the persistent application shell.
 *
 * Renders the CSS Grid layout (titlebar + rail/list/main/aside), wires the two
 * resizable panels, and keeps :root layout variables in sync with the layout
 * store. Route content renders into the `main` region via <Outlet/>.
 */
export default function App() {
  const layout = useLayoutStore();

  // Reflect layout state onto :root whenever the relevant fields change.
  useEffect(() => {
    applyLayout({
      railVisible: layout.railVisible,
      asideVisible: layout.asideVisible,
      listWidth: layout.listWidth,
      asideWidth: layout.asideWidth,
      density: layout.density,
    });
  }, [
    layout.railVisible,
    layout.asideVisible,
    layout.listWidth,
    layout.asideWidth,
    layout.density,
  ]);

  const listResize = useResizable({
    width: layout.listWidth,
    onWidth: layout.setListWidth,
    edge: "right",
  });
  const asideResize = useResizable({
    width: layout.asideWidth,
    onWidth: layout.setAsideWidth,
    edge: "left",
  });

  const resizing = listResize.dragging || asideResize.dragging;
  const customizeOpen = useUiStore((s) => s.customizeOpen);
  const setCustomizeOpen = useUiStore((s) => s.setCustomizeOpen);
  const togglePalette = useUiStore((s) => s.togglePalette);
  const openShortcuts = useUiStore((s) => s.openShortcuts);
  const navigate = useNavigate();
  // The right panel follows the route: members in a chat, the friends list on
  // /friends, and nothing at all where it has no meaning.
  const { pathname } = useLocation();
  // Une tuile d'appel agrandie prend TOUT l'espace (comme /admin) : l'aside
  // membres disparaît tant que la scène est ouverte sur la conversation active.
  const callStageConv = useCallStore((s) =>
    s.status === "in-call" && s.focusedTile ? s.conversationId : null,
  );
  const activeConvId = useConversationsStore((s) => s.activeId);
  const noAside =
    pathname === "/admin" ||
    pathname === "/settings" ||
    pathname === "/changelog" ||
    pathname === "/leaderboard" ||
    (pathname === "/" && !!callStageConv && callStageConv === activeConvId);

  // Global keyboard shortcuts (⌘/Ctrl based).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+↑/↓ — previous/next conversation; Alt+Shift+↓ — next unread.
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const s = useConversationsStore.getState();
        if (e.shiftKey) {
          const unread = s.conversations.find((c) => c.unread > 0 && c.id !== s.activeId);
          if (unread) {
            navigate("/");
            void openConversation(unread.id);
          }
          return;
        }
        const list = s.conversations;
        if (list.length === 0) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const idx = list.findIndex((c) => c.id === s.activeId);
        const next =
          idx === -1
            ? dir === 1
              ? list[0]
              : list[list.length - 1]
            : list[(idx + dir + list.length) % list.length];
        if (next && next.id !== s.activeId) {
          navigate("/");
          void openConversation(next.id);
        }
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        togglePalette();
      } else if (k === "/") {
        e.preventDefault();
        openShortcuts();
      } else if (e.key === ",") {
        e.preventDefault();
        navigate("/settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, openShortcuts, navigate]);

  // Native notification clicks land here: focus the conversation wherever we
  // were. Also drains a click that launched the app before this listener
  // existed (the Rust side stashes it).
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    const open = (conversationId: string) => {
      navigate("/");
      void openConversation(conversationId);
    };
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen<string>("accord://notification-clicked", (e) => open(e.payload));
      if (!alive) return stop();
      unlisten = stop;
      const pending = await invoke<string | null>("notif_take_pending_click").catch(() => null);
      if (alive && pending) open(pending);
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [navigate]);

  return (
    <>
      <AppBackground />
      <div className="app-grain" aria-hidden />
      <div className="shell" data-resizing={resizing} data-no-aside={noAside}>
      <ShellTitlebar />

      <nav className="shell__rail" aria-label="Navigation principale">
        <InstanceRail />
      </nav>

      <section className="shell__list" aria-label="Conversations">
        <ConversationList />
        {/* Right-edge handle resizes the list panel. */}
        <div
          className="resize-handle resize-handle--right"
          data-dragging={listResize.dragging}
          aria-label="Redimensionner la liste des conversations"
          {...listResize.handleProps}
        />
      </section>

      <main className="shell__main">
        <Outlet />
      </main>

      <aside className="shell__aside" aria-label="Détails">
        {pathname === "/friends" ? <FriendsAside /> : <ConversationDetails />}
        {/* Left-edge handle resizes the aside panel. */}
        <div
          className="resize-handle"
          style={{ left: -5 }}
          data-dragging={asideResize.dragging}
          aria-label="Redimensionner le panneau des détails"
          {...asideResize.handleProps}
        />
      </aside>
      </div>
      <CustomizePanel open={customizeOpen} onClose={() => setCustomizeOpen(false)} />
      <CommandPalette />
      <ShortcutsCheatsheet />
      <CallPip />
      <ConnectionBanner />
      <TransparencyBanner />
      <IncomingCallModal />
    </>
  );
}

/** Titlebar — a slim strip doubling as the window drag region. Brand on the
 * left (padded past the native traffic lights on macOS — the window uses the
 * Overlay title-bar style); a single theme toggle on the right.
 *
 * `data-tauri-drag-region` only fires when the pressed element ITSELF carries
 * the attribute, so it sits on the header and its passive children — buttons
 * stay clickable with no opt-out needed. Double-click toggles maximize. */
function ShellTitlebar() {
  const toggleScheme = useThemeStore((s) => s.toggleScheme);
  const scheme = useThemeStore((s) => s.document.name);

  return (
    <header className="shell__titlebar" data-tauri-drag-region>
      <span className="shell__brand" data-tauri-drag-region>
        Accord
      </span>
      <div className="shell__titlebar-spacer" data-tauri-drag-region />
      <Tooltip label="Thème clair / sombre">
        <IconButton aria-label="Basculer le thème" onClick={toggleScheme}>
          <Icon name={scheme === "dark" ? "moon" : "sun"} />
        </IconButton>
      </Tooltip>
    </header>
  );
}

