import { useEffect, useMemo, useRef } from 'react';
import { Box } from '@mui/material';

// Fibonacci-sphere distribution → Euler angles for CSS transforms.
function fibonacciDirections(n: number): Array<{ theta: number; elev: number }> {
  const out: Array<{ theta: number; elev: number }> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const t = golden * i;
    const x = Math.cos(t) * r;
    const z = Math.sin(t) * r;
    const theta = (Math.atan2(-z, x) * 180) / Math.PI;
    const elev = (Math.asin(y) * 180) / Math.PI;
    out.push({ theta, elev });
  }
  return out;
}

// Central glowing sphere with thin rays radiating outward.
//
// Earlier iterations had two problems:
//   1. Tip beads dominated visually and dissolved into floating ovals when
//      foreshortened. Removed.
//   2. An "inner offset" left a gap between origin and the visible part of
//      each ray, so heavily-rotated rays looked detached from the hub.
//      Removed — every ray now starts at origin and the hub is rendered on
//      top to hide the inner bit cleanly.
//   3. `border-radius: 999px` on rays turned foreshortened rectangles into
//      bean shapes. Replaced with sharp rectangles.
//
// What's left: one solid sphere + 16 thin rays of varying lengths, rotating
// to follow the cursor. Reads cleanly at any orientation.
export function MagicBall({
  size = 56,
  color = 'currentColor',
  spikeCount = 80,
}: {
  size?: number;
  color?: string;
  spikeCount?: number;
}) {
  const sphereRef = useRef<HTMLDivElement>(null);

  const struts = useMemo(() => {
    // Length pattern — kept tight (75% – 100%) so the silhouette reads as
    // a single fluffy boundary rather than a starburst with two distinct
    // shells. Fibonacci sphere keeps angular density uniform on every face.
    const pattern = [1.0, 0.84, 0.92, 0.78, 0.96, 0.86, 0.8, 0.94, 0.88, 0.76];
    return fibonacciDirections(spikeCount).map((dir, i) => ({
      ...dir,
      length: pattern[i % pattern.length],
    }));
  }, [spikeCount]);

  useEffect(() => {
    const sphere = sphereRef.current;
    if (!sphere) return;

    let raf = 0;
    let targetX = 8;
    let targetY = -10;
    let curX = 8;
    let curY = -10;

    const apply = () => {
      sphere.style.transform = `rotateX(${curX.toFixed(2)}deg) rotateY(${curY.toFixed(2)}deg)`;
    };
    apply();

    const tick = () => {
      const dx = targetX - curX;
      const dy = targetY - curY;
      curX += dx * 0.09;
      curY += dy * 0.09;
      apply();
      if (Math.abs(dx) > 0.04 || Math.abs(dy) > 0.04) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(tick);
    };

    // Cursor follow — cursor right ⇒ ball rotates so its right side comes
    // toward the viewer (rotateY negative in CSS); cursor down ⇒ ball tilts
    // down with top forward (rotateX negative).
    const onMove = (e: MouseEvent) => {
      const x = e.clientX / window.innerWidth - 0.5;
      const y = e.clientY / window.innerHeight - 0.5;
      targetY = -x * 140;
      targetX = -y * 110;
      schedule();
    };

    // Idle wobble — 2× the previous speed (Δwobble 0.05 vs 0.025) so the
    // ball reads as actively self-rotating instead of barely drifting.
    let wobble = Math.random() * Math.PI * 2;
    let wobbleHandle: number | null = window.setInterval(() => {
      wobble += 0.05;
      targetY = Math.sin(wobble) * 18;
      targetX = Math.cos(wobble * 0.7) * 12;
      schedule();
    }, 50);
    const cancelWobble = () => {
      if (wobbleHandle !== null) {
        window.clearInterval(wobbleHandle);
        wobbleHandle = null;
      }
    };
    const onMoveOnce = (e: MouseEvent) => {
      cancelWobble();
      onMove(e);
      window.addEventListener('mousemove', onMove);
      window.removeEventListener('mousemove', onMoveOnce);
    };
    window.addEventListener('mousemove', onMoveOnce);

    return () => {
      cancelWobble();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousemove', onMoveOnce);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Thin individual hairs — at this density, thicker shafts would clump
  // into a solid blob. 1.1 – 1.3 px reads like fuzz fibres.
  const strutThickness = Math.max(1.1, size * 0.022);

  return (
    <Box
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        perspective: size * 5,
        color,
        position: 'relative',
      }}
    >
      <Box
        ref={sphereRef}
        sx={{
          width: '100%',
          height: '100%',
          position: 'relative',
          transformStyle: 'preserve-3d',
          willChange: 'transform',
        }}
      >
        {/* Rays — each is a single rectangle from origin. The 80 of them
            converge at the centre forming the fluff ball; nothing else is
            rendered (no hub, no silhouette ring) so there are no foreign
            ovals or stray "balls" floating around when rotated. */}
        {struts.map((s, i) => {
          const lineLength = (size / 2) * s.length;
          return (
            <Box
              key={i}
              sx={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: lineLength,
                height: strutThickness,
                marginTop: -strutThickness / 2,
                transformOrigin: '0% 50%',
                transform: `rotateY(${s.theta}deg) rotateZ(${s.elev}deg)`,
                background: 'currentColor',
                borderRadius: 0,
                // Slight per-strut opacity variation breaks the otherwise
                // mathematically-perfect fibonacci uniformity, giving an
                // organic "fluff" look.
                opacity: 0.62 + ((i * 37) % 32) / 100,
                pointerEvents: 'none',
              }}
            />
          );
        })}
      </Box>
    </Box>
  );
}
