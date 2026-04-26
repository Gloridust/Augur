// Augur brand mark — a 16-point asterisk inspired by Claude's logo.
// Eight ellipses rotated 22.5° apart give us the soft star-burst feel
// without drawing 16 individual paths.
export function AugurMark({
  size = 24,
  color = 'currentColor',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color}
      aria-hidden
    >
      {[0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5].map((deg) => (
        <ellipse
          key={deg}
          cx="12"
          cy="12"
          rx="1"
          ry="11"
          transform={`rotate(${deg} 12 12)`}
        />
      ))}
    </svg>
  );
}
