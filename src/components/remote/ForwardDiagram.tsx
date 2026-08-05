import type { ForwardKind } from "../../types/remote";

/**
 * Which way a forward points, drawn.
 *
 * Local vs remote is the thing everyone gets backwards, and no amount of wording fixes it — "opens a
 * port here that reaches there" and "opens a port there that reaches here" are the same sentence
 * with two words swapped, which is exactly why they get confused. A picture makes the direction
 * structural instead of textual: the filled dot is the end that opens the port, and the arrow is
 * which way traffic then travels.
 *
 * Inline SVG rather than an asset: it has to follow the theme, and three PNGs in two themes is six
 * files to keep in step with a colour token.
 */
export function ForwardDiagram({ kind }: { kind: ForwardKind }) {
  return (
    <svg
      viewBox="0 0 260 54"
      role="img"
      aria-label={LABELS[kind]}
      className="h-[54px] w-full max-w-[260px]"
    >
      <title>{LABELS[kind]}</title>

      <Node x={4} label="you" filled={kind !== "remote"} />
      <Node x={100} label="ssh" />
      {kind === "dynamic" ? <Cloud x={196} /> : <Node x={196} label="target" filled={kind === "remote"} />}

      {/* Always left-to-right between the boxes: the SSH connection itself is established from here
          in every case. What differs is which end listens, which the dots carry. */}
      <Arrow from={60} to={100} />
      <Arrow from={156} to={196} dashed={kind === "dynamic"} />
    </svg>
  );
}

const LABELS: Record<ForwardKind, string> = {
  local: "A port opened on this machine reaches a service on the far side",
  remote: "A port opened on the far host reaches a service on this machine",
  dynamic: "A SOCKS proxy on this machine sends traffic out through the far host",
};

/** A machine. `filled` marks the end that opens the listening port. */
function Node({ x, label, filled = false }: { x: number; label: string; filled?: boolean }) {
  return (
    <g>
      <rect
        x={x}
        y={10}
        width={56}
        height={26}
        rx={5}
        fill={filled ? "var(--cf-accent-soft)" : "transparent"}
        stroke={filled ? "var(--cf-accent)" : "var(--cf-border)"}
        strokeWidth={1}
      />
      <text
        x={x + 28}
        y={27}
        textAnchor="middle"
        fontSize={10}
        fill={filled ? "var(--cf-accent)" : "var(--cf-text-muted)"}
      >
        {label}
      </text>
      {filled && (
        <circle cx={x + 28} cy={44} r={2.5} fill="var(--cf-accent)">
          <title>opens the port</title>
        </circle>
      )}
    </g>
  );
}

/** The "anywhere" end of a dynamic forward: it has no single target, which is the whole point. */
function Cloud({ x }: { x: number }) {
  return (
    <g>
      <rect
        x={x}
        y={10}
        width={56}
        height={26}
        rx={13}
        fill="transparent"
        stroke="var(--cf-border)"
        strokeDasharray="3 3"
      />
      <text x={x + 28} y={27} textAnchor="middle" fontSize={10} fill="var(--cf-text-muted)">
        anywhere
      </text>
    </g>
  );
}

function Arrow({ from, to, dashed = false }: { from: number; to: number; dashed?: boolean }) {
  const mid = 23;
  return (
    <g stroke="var(--cf-text-muted)" strokeWidth={1} fill="none">
      <line
        x1={from}
        y1={mid}
        x2={to - 5}
        y2={mid}
        strokeDasharray={dashed ? "3 3" : undefined}
      />
      <polyline points={`${to - 9},${mid - 3} ${to - 4},${mid} ${to - 9},${mid + 3}`} />
    </g>
  );
}
