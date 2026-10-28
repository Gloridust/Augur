import { extractDomain } from '../shared/db';
import { scoreDomains, type RecommendCallContext } from './recommend';

const NEW_PIN_BOOST_HOURS = 24;

export interface PinRerankInput {
  url: string;
  pinnedAt: number;
}

export interface PinRerankRow {
  url: string;
  score: number;
}

// Score each pinned URL with the **same Head-A model** used for the smart
// suggestions row — the live ensemble, through the shared feature builder.
// Pins are not a separate ranking surface with hand-tuned weights; they're
// another consumer of the open-recommendation model.
//
// The only product-specific addition is a fading "new pin boost" so a freshly
// added pin always comes to the front for ~24h regardless of model output —
// otherwise a brand-new pin (no domain stats yet) would sink to the bottom
// and the user would think their pin was lost.
export async function rerankPins(
  pins: PinRerankInput[],
  context: RecommendCallContext,
): Promise<PinRerankRow[]> {
  if (pins.length === 0) return [];
  const now = Date.now();
  const domains = [...new Set(pins.map((p) => extractDomain(p.url)).filter(Boolean))];
  const scores = await scoreDomains(context, domains);

  const out: PinRerankRow[] = pins.map((p) => {
    const domain = extractDomain(p.url);
    let score = domain ? (scores.get(domain) ?? 0) : 0;
    // Fresh-pin protection: linear decay from +0.45 → 0 across 24h.
    const ageHours = (now - p.pinnedAt) / (60 * 60 * 1000);
    if (ageHours < NEW_PIN_BOOST_HOURS) {
      score += 0.45 * (1 - ageHours / NEW_PIN_BOOST_HOURS);
    }
    return { url: p.url, score };
  });
  return out.sort((a, b) => b.score - a.score);
}
