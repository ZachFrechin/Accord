import * as RadixToast from "@radix-ui/react-toast";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

import { Icon } from "./Icon";

/** A single toast payload. */
export interface ToastItem {
  id: number;
  title: ReactNode;
  description?: ReactNode;
}

/** Context value: a function to enqueue a toast. */
interface ToastApi {
  toast: (t: Omit<ToastItem, "id">) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * useToast — access the imperative toast enqueue function.
 *
 * Must be called under a <ToastProvider>. Returns `{ toast }` where `toast()`
 * shows a transient notification.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

/**
 * ToastProvider — wraps the app with Radix Toast plumbing.
 *
 * Holds the queue of active toasts, renders each as a Radix Toast, and exposes
 * an imperative `toast()` via context. Includes the single fixed Viewport.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((t: Omit<ToastItem, "id">) => {
    setItems((prev) => [...prev, { ...t, id: Date.now() + Math.random() }]);
  }, []);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {items.map((t) => (
          <RadixToast.Root
            key={t.id}
            className="toast"
            duration={4000}
            onOpenChange={(open) => {
              if (!open) remove(t.id);
            }}
          >
            <RadixToast.Title className="toast__title">
              {t.title}
            </RadixToast.Title>
            {t.description ? (
              <RadixToast.Description className="toast__desc">
                {t.description}
              </RadixToast.Description>
            ) : null}
            <RadixToast.Close className="toast__close" aria-label="Fermer">
              <Icon name="x" size={16} />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="toast__viewport" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
