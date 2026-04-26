import { extractDomain } from '../shared/db';
import type { RecommendCallContext } from './recommend';
import { getEmbedding } from './embedding-train';
import { buildRecommendFeatures, vectorFromRecommend } from './features';
import { loadRecommendModel } from './persistence';
import { RECOMMEND_FEATURE_NAMES } from './features';
import { sessionContext, visitVelocity } from './timeseries';

const FEATURE_COUNT = RECOMMEND_FEATURE_NAMES.length;
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
// suggestions row. This is the entire point of the recent ML refactor: pins
// are not a separate ranking surface with hand-tuned weights, they're another
// consumer of the open-recommendation model.
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
  const model = await loadRecommendModel(FEATURE_COUNT);
  const embedding = await getEmbedding();
  const now = Date.now();
  const focused = context.focusedDomain;
  const openSet = new Set(context.openDomains);
  const pinnedSet = new Set(context.pinnedDomains ?? []);

  const out: PinRerankRow[] = [];
  for (const p of pins) {
    const domain = extractDomain(p.url);
    if (!domain) {
      out.push({ url: p.url, score: 0 });
      continue;
    }
    const embedSim = focused ? embedding.cosine(domain, focused) : 0;
    const [vel, sess] = await Promise.all([
      visitVelocity(domain, now),
      sessionContext(domain, now),
    ]);
    const features = await buildRecommendFeatures({
      domain,
      context,
      isCurrentlyOpen: openSet.has(domain),
      isPinnedSomewhere: pinnedSet.has(domain),
      embedSimToFocused: embedSim,
      visitVelocity: vel,
      sessionContext: sess,
      now,
    });
    let score = model.predict(vectorFromRecommend(features));

    // Fresh-pin protection: linear decay from +0.45 → 0 across 24h.
    const ageHours = (now - p.pinnedAt) / (60 * 60 * 1000);
    if (ageHours < NEW_PIN_BOOST_HOURS) {
      score += 0.45 * (1 - ageHours / NEW_PIN_BOOST_HOURS);
    }

    out.push({ url: p.url, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
