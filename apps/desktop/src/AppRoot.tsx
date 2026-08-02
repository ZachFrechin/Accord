/**
 * Top-level gate: onboarding vs the connected app.
 *
 * Shows onboarding when there is no authenticated active instance (or the user
 * asked to add another). Otherwise mounts the shell inside a ConnectionProvider
 * keyed by instance id, so switching instances fully tears down and re-establishes
 * the connection.
 */

import { Suspense, lazy, useEffect, type ComponentType, type ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router";

import App from "./App";
import { UpdateBanner } from "./components/UpdateBanner";
import { initAppBadge } from "./lib/appBadge";
import { initDeepLinks } from "./lib/deepLinks";
import { callViewParams, popoutConversationId } from "./lib/popout";
import { CallViewerWindow } from "./components/call/CallViewerWindow";
import { messagingReady, openConversation } from "./stores/messagingActions";
import { useConversationsStore } from "./stores/useConversationsStore";
import { AppBackground } from "./components/AppBackground";
import ChatPane from "./components/messaging/ChatPane";
import { ConnectionProvider } from "./realtime/ConnectionProvider";
import { MessagingProvider } from "./realtime/MessagingProvider";
import Onboarding from "./routes/Onboarding";

// Secondary pages load on demand: the messaging surface (ChatPane) and the
// onboarding stay in the main chunk, everything else splits out so first paint
// doesn't pay for admin/settings/changelog code. Chunks are local files — the
// null Suspense fallback is invisible in practice.
const AdminPage = lazy(() => import("./routes/AdminPage"));
const ChangelogPage = lazy(() => import("./routes/ChangelogPage"));
const DesignGallery = lazy(() => import("./routes/DesignGallery"));
const FriendsPage = lazy(() => import("./routes/FriendsPage"));
const LeaderboardPage = lazy(() => import("./routes/LeaderboardPage"));
const HomeConnected = lazy(() => import("./routes/HomeConnected"));
import { activeInstance, useInstanceStore } from "./stores/useInstanceStore";
import { useSessionStore } from "./stores/useSessionStore";
import { useUiStore } from "./stores/useUiStore";

/** The pop-out window's whole UI: the conversation, nothing else (native
 * window chrome carries the title). */
function PopoutShell({ conversationId }: { conversationId: string }) {
  const title = useConversationsStore((s) => s.titles[conversationId]);
  useEffect(() => {
    // Cette fenêtre monte AVANT la fin de l'init messaging : ouvrir tout de
    // suite tombait sur le garde `!rt` et laissait l'écran « Vos messages ».
    let alive = true;
    void messagingReady().then((ok) => {
      if (alive && ok) void openConversation(conversationId);
    });
    return () => {
      alive = false;
    };
  }, [conversationId]);
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  return (
    <>
      <AppBackground />
      <div className="popout">
        <ChatPane />
      </div>
    </>
  );
}

/** Suspend only the outlet area (the App shell stays mounted while a chunk loads). */
function lazyPage(Page: ComponentType): ReactElement {
  return (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  );
}

export default function AppRoot() {
  useEffect(() => {
    initAppBadge();
    initDeepLinks();
  }, []);
  const instance = useInstanceStore(activeInstance);
  const authed = useSessionStore((s) => (instance ? (s.authed[instance.id] ?? false) : false));
  const onboardingOpen = useUiStore((s) => s.onboardingOpen);

  // The update banner mounts OUTSIDE the auth gate so a signed-out user (or a
  // fresh install on the onboarding screen) still sees and can install updates.
  if (!instance || !authed || onboardingOpen) {
    return (
      <>
        <UpdateBanner />
        <Onboarding />
      </>
    );
  }

  // Fenêtre spectateur d'appel (?callview=<conv>&tile=<id>) : un seul flux
  // vidéo, providers complets (le runtime messaging fournit jointure + clé MLS).
  const callView = callViewParams();
  if (callView) {
    return (
      <ConnectionProvider key={instance.id} instance={instance}>
        <MessagingProvider>
          <CallViewerWindow
            conversationId={callView.conversationId}
            tile={callView.tile}
          />
        </MessagingProvider>
      </ConnectionProvider>
    );
  }

  // Popped-out conversation window (?popout=<id>): minimal shell, same
  // providers — the native MLS engine is shared process-wide, only the JS
  // stores are per-window.
  const popoutId = popoutConversationId();
  if (popoutId) {
    return (
      <ConnectionProvider key={instance.id} instance={instance}>
        <MessagingProvider>
          <BrowserRouter>
            <PopoutShell conversationId={popoutId} />
          </BrowserRouter>
        </MessagingProvider>
      </ConnectionProvider>
    );
  }

  return (
    <ConnectionProvider key={instance.id} instance={instance}>
      <MessagingProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<App />}>
              <Route index element={<ChatPane />} />
              <Route path="friends" element={lazyPage(FriendsPage)} />
              <Route path="leaderboard" element={lazyPage(LeaderboardPage)} />
              <Route path="admin" element={lazyPage(AdminPage)} />
              <Route path="changelog" element={lazyPage(ChangelogPage)} />
              <Route path="settings" element={lazyPage(HomeConnected)} />
              {/* Dev-only design gallery (English placeholder copy) — never ships. */}
              {import.meta.env.DEV && <Route path="design" element={lazyPage(DesignGallery)} />}
            </Route>
          </Routes>
        </BrowserRouter>
        <UpdateBanner />
      </MessagingProvider>
    </ConnectionProvider>
  );
}
