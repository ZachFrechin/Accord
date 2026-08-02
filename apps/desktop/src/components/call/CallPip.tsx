/**
 * Floating call pill (Phase 4). Shown while a call is active but you're NOT
 * viewing its conversation (the CallBanner covers that case in-chat). Click the
 * title to jump back to the call's conversation; quick mic + hang-up controls.
 */

import { useLocation, useNavigate } from "react-router-dom";

import { openConversation } from "../../stores/messagingActions";
import { useCallStore } from "../../stores/useCallStore";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { Icon } from "../ui";
import { MicGlyph } from "./MicGlyph";
import "./call.css";

export function CallPip() {
  const status = useCallStore((s) => s.status);
  const callConvId = useCallStore((s) => s.conversationId);
  const micEnabled = useCallStore((s) => s.micEnabled);
  const encrypted = useCallStore((s) => s.encrypted);
  const toggleMic = useCallStore((s) => s.toggleMic);
  const leaveCall = useCallStore((s) => s.leaveCall);
  const activeId = useConversationsStore((s) => s.activeId);
  const title = useConversationsStore((s) => (callConvId ? s.titles[callConvId] : null));
  const { pathname } = useLocation();
  const navigate = useNavigate();

  if (status === "idle") return null;
  // Hidden while actually viewing the call's conversation — the banner is there.
  if (pathname === "/" && activeId === callConvId) return null;

  const goToCall = () => {
    if (!callConvId) return;
    void openConversation(callConvId);
    navigate("/");
  };

  return (
    <div className="call-pip" data-status={status}>
      <button type="button" className="call-pip__main" onClick={goToCall} title="Revenir à l'appel">
        <span className="call-pip__dot" aria-hidden />
        <span className="call-pip__title">{title ?? "Appel"}</span>
        {status === "in-call" &&
          (encrypted ? (
            <Icon name="lock" size={12} className="call-pip__lock" aria-label="Chiffré" />
          ) : (
            <span className="call-pip__warn" title="Média non chiffré (dev)">
              non chiffré
            </span>
          ))}
      </button>
      <button
        type="button"
        className="call-ctl call-ctl--sm"
        data-off={!micEnabled}
        onClick={() => void toggleMic()}
        disabled={status !== "in-call"}
        aria-label={micEnabled ? "Couper le micro" : "Activer le micro"}
        title={micEnabled ? "Couper le micro" : "Activer le micro"}
      >
        <MicGlyph muted={!micEnabled} size={16} />
      </button>
      <button
        type="button"
        className="call-ctl call-ctl--sm call-ctl--hangup"
        onClick={leaveCall}
        aria-label="Raccrocher"
        title="Raccrocher"
      >
        <Icon name="phone" size={14} />
      </button>
    </div>
  );
}
