import { cn } from "@/lib/utils";

interface SpinnerProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

const sizeMap = {
  sm: "h-4 w-4 border-2",
  md: "h-6 w-6 border-2",
  lg: "h-8 w-8 border-3",
};

export function Spinner({ className, size = "md" }: SpinnerProps) {
  return (
    <div
      className={cn(
        "animate-spin rounded-full border-muted-foreground/30 border-t-primary",
        sizeMap[size],
        className,
      )}
    />
  );
}

export function LoadingState({ text = "Loading..." }: { text?: string }) {
  return (
    <div className="flex items-center gap-3 text-muted-foreground py-8">
      <Spinner />
      <span className="text-sm">{text}</span>
    </div>
  );
}
