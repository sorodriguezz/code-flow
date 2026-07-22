import type { CSSProperties } from "react";

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div className={`cf-skeleton ${className}`} style={style} />;
}

export function SkeletonRows({ count = 6, className = "" }: { count?: number; className?: string }) {
  return (
    <div className={`space-y-2 p-2 ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-4" style={{ width: `${55 + ((i * 13) % 40)}%` }} />
      ))}
    </div>
  );
}
