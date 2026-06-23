import { useState, useCallback, type ReactNode } from "react";
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from "./dialog";
import { Button } from "./button";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  confirmText?: string;
  confirmVariant?: "default" | "destructive";
  isPending?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmText = "Confirm",
  confirmVariant = "destructive",
  isPending,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="text-sm text-muted-foreground">{children}</div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
        <Button variant={confirmVariant} onClick={onConfirm} disabled={isPending}>
          {isPending ? "Processing..." : confirmText}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Hook for managing a confirm dialog state.
 * Returns [dialogProps, requestConfirm] — call requestConfirm(callback) to show
 * the dialog, which calls callback on confirm.
 */
export function useConfirmDialog() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [onConfirmRef, setOnConfirmRef] = useState<(() => void) | null>(null);

  const requestConfirm = useCallback((onConfirm: () => void) => {
    setOnConfirmRef(() => onConfirm);
    setOpen(true);
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirmRef?.();
    setOpen(false);
  }, [onConfirmRef]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  return {
    dialogProps: { open, onClose: handleClose, onConfirm: handleConfirm, isPending: pending },
    requestConfirm,
    setPending,
  };
}
