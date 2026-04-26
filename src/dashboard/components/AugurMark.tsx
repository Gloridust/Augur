// Augur brand mark — 2D mirror of icon.svg's fluff-ball.
//
// 48 thin rays radiating from origin at 7.5° intervals, with a 10-step
// length pattern (76% – 100% of full radius). No core sphere, no tip
// beads — matches the live MagicBall and the favicon. Single colour,
// inherited from parent via currentColor.
const RAY_LENGTH_PATTERN = [1.0, 0.84, 0.92, 0.78, 0.96, 0.86, 0.8, 0.94, 0.88, 0.76];
const RAY_COUNT = 48;

export function AugurMark({
  size = 28,
  color = 'currentColor',
}: {
  size?: number;
  color?: string;
}) {
  const step = 360 / RAY_COUNT;
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      aria-hidden
    >
      <g
        transform="translate(16 16)"
        stroke={color}
        strokeWidth={1}
        strokeLinecap="round"
      >
        {Array.from({ length: RAY_COUNT }, (_, i) => {
          const length = 12.5 * RAY_LENGTH_PATTERN[i % RAY_LENGTH_PATTERN.length];
          const angle = i * step;
          return (
            <line
              key={i}
              x1={0}
              y1={0}
              x2={length}
              y2={0}
              transform={`rotate(${angle})`}
              opacity={0.7 + ((i * 37) % 30) / 100}
            />
          );
        })}
      </g>
    </svg>
  );
}
