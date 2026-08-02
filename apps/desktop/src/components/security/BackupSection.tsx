/**
 * BackupSection — export/import the encrypted local history (Réglages →
 * Sauvegarde). The MLS plaintext only exists on this device; the export seals
 * it under a passphrase so a machine change doesn't mean losing the thread.
 */

import { type ChangeEvent, useRef, useState } from "react";

import { exportHistory, importHistory } from "../../lib/historyBackup";
import { openConversation } from "../../stores/messagingActions";
import { activeInstance, useInstanceStore } from "../../stores/useInstanceStore";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { useMessagesStore } from "../../stores/useMessagesStore";
import { Button, Field, useToast } from "../ui";

export function BackupSection() {
  const { toast } = useToast();
  const instanceId = useInstanceStore((s) => activeInstance(s)?.id ?? null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const tooShort = passphrase.length < 8;

  const doExport = async () => {
    if (!instanceId || tooShort) return;
    setBusy(true);
    try {
      const { blob, messages, conversations } = await exportHistory(instanceId, passphrase);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `accord-historique-${new Date().toISOString().slice(0, 10)}.accordbackup`;
      a.click();
      URL.revokeObjectURL(url);
      toast({
        title: "Sauvegarde exportée",
        description: `${messages} messages de ${conversations} conversation${conversations > 1 ? "s" : ""}.`,
      });
    } catch (e) {
      toast({
        title: "Échec de l'export",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !instanceId || tooShort) return;
    setBusy(true);
    try {
      const { messages, conversations } = await importHistory(instanceId, file, passphrase);
      // Loaded conversations re-read IndexedDB on next open — force the active
      // one through now so the merge is visible immediately.
      const activeId = useConversationsStore.getState().activeId;
      useMessagesStore.getState().reset();
      if (activeId) void openConversation(activeId);
      toast({
        title: "Sauvegarde importée",
        description: `${messages} messages fusionnés dans ${conversations} conversation${conversations > 1 ? "s" : ""}.`,
      });
    } catch (err) {
      toast({
        title: "Échec de l'import",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backup">
      <p className="home__hint">
        L'historique chiffré de bout en bout n'existe que sur cet appareil (confidentialité
        persistante oblige). Exportez-le, scellé par une phrase secrète, pour pouvoir le
        restaurer sur une autre machine. L'import fusionne sans dupliquer.
      </p>
      <Field
        label="Phrase secrète (8 caractères minimum)"
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Choisissez une phrase robuste"
      />
      <div className="backup__actions">
        <Button size="sm" disabled={busy || tooShort || !instanceId} onClick={() => void doExport()}>
          {busy ? "…" : "Exporter l'historique"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || tooShort || !instanceId}
          onClick={() => fileRef.current?.click()}
        >
          Importer une sauvegarde
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".accordbackup"
          hidden
          onChange={(e) => void doImport(e)}
        />
      </div>
    </div>
  );
}
