export function BouncingDots({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-[13px] text-[var(--cf-text-muted)]">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="cf-bounce-dot h-1.5 w-1.5 rounded-full bg-[var(--cf-accent)]"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      {label && <span>{label}</span>}
    </div>
  );
}
