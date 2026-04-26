// Augur brand mark — 2D mirror of the icon.svg "expansion ball".
//
// Mechanical structure: 12 front struts radiate from a central hub, each
// terminating in a small bead. 6 back struts (offset 15°) sit at half
// opacity to suggest the far side of a sphere. Long/short alternation in
// strut length adds the "compressed/expanded" mechanical feel.
//
// Single colour input — parent decides the hue. At 16-20px the small
// back struts disappear into the noise; the 12 front struts + hub + tips
// remain clearly readable.
const FRONT_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const BACK_ANGLES = [15, 75, 135, 195, 255, 315];

export function AugurMark({
  size = 28,
  color = 'currentColor',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      aria-hidden
    >
      <g transform="translate(16 16)">
        {/* Back struts (faded) */}
        <g stroke={color} strokeLinecap="round" opacity={0.4}>
          {BACK_ANGLES.map((a) => (
            <line
              key={`b-${a}`}
              x1={0}
              y1={0}
              x2={11}
              y2={0}
              strokeWidth={1.1}
              transform={`rotate(${a})`}
            />
          ))}
        </g>
        {/* Front struts — alternating lengths for that "Hoberman compressed" feel */}
        <g stroke={color} strokeLinecap="round">
          {FRONT_ANGLES.map((a, i) => (
            <line
              key={`f-${a}`}
              x1={0}
              y1={0}
              x2={i % 2 === 0 ? 12 : 10.5}
              y2={0}
              strokeWidth={1.4}
              transform={`rotate(${a})`}
            />
          ))}
        </g>
        {/* Beads at front strut tips. Pre-computed positions for the 12
            evenly-spaced angles (every 30°). */}
        <g fill={color}>
          <circle cx={12} cy={0} r={1.5} />
          <circle cx={9.1} cy={5.25} r={1.2} />
          <circle cx={6} cy={10.4} r={1.5} />
          <circle cx={0} cy={10.5} r={1.2} />
          <circle cx={-6} cy={10.4} r={1.5} />
          <circle cx={-9.1} cy={5.25} r={1.2} />
          <circle cx={-12} cy={0} r={1.5} />
          <circle cx={-9.1} cy={-5.25} r={1.2} />
          <circle cx={-6} cy={-10.4} r={1.5} />
          <circle cx={0} cy={-10.5} r={1.2} />
          <circle cx={6} cy={-10.4} r={1.5} />
          <circle cx={9.1} cy={-5.25} r={1.2} />
        </g>
        {/* Solid hub */}
        <circle r={2.7} fill={color} />
      </g>
    </svg>
  );
}
