import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { Button } from "./Button";
import { Dialog } from "./Dialog";

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  /** Confirm button label (defaults to "Confirmer"). */
  confirmLabel?: string;
  /** Cancel button label (defaults to "Annuler"). */
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * useConfirm — imperative confirmation prompt.
 *
 * Returns a function that resolves to `true`/`false`:
 *   if (await confirm({ title: "Retirer cet ami ?", danger: true })) { ... }
 * Must be used under a <ConfirmProvider>.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

/**
 * ConfirmProvider — hosts a single modal confirmation dialog and exposes an
 * imperative `confirm()` via context (mirrors the ToastProvider pattern).
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((result: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    setOpts(options);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setOpts(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={opts !== null}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
        title={opts?.title ?? ""}
        description={opts?.description}
      >
        <div className="confirm__actions">
          <Button variant="ghost" onClick={() => settle(false)}>
            {opts?.cancelLabel ?? "Annuler"}
          </Button>
          <Button variant={opts?.danger ? "danger" : "primary"} onClick={() => settle(true)}>
            {opts?.confirmLabel ?? "Confirmer"}
          </Button>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
