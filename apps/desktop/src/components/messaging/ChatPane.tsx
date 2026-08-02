/** The index route content in the shell `main` region: the open chat, or a
 * zero-state when nothing is selected. Reads the shared activeId so it reacts to
 * selections made in the (non-routed) conversation list. */

import { useConversationsStore } from "../../stores/useConversationsStore";
import { EmptyState } from "../ui";
import { ChatView } from "./ChatView";

export default function ChatPane() {
  const activeId = useConversationsStore((s) => s.activeId);

  if (!activeId) {
    return (
      <EmptyState
        title="Vos messages"
        description="Choisissez une conversation, ou ouvrez « Amis » pour démarrer un échange chiffré de bout en bout."
      />
    );
  }
  return <ChatView conversationId={activeId} />;
}
