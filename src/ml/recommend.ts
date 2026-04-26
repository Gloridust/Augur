import { db, extractDomain } from '../shared/db';
import type {
  DomainStats,
  OpenCandidate,
  RecommendFeatures,
  RecommendationContext,
  TabEvent,
} from '../shared/types';
import { getTopDomainsByFrecency } from './aggregate';
import { getEmbedding } from './embedding-train';
import { sessionContext as sessionContextFeature, visitVelocity } from './timeseries';
import {
  RECOMMEND_FEATURE_NAMES,
  buildRecommendFeatures,
  summarizeOpenReason,
  vectorFromRecommend,
} from './features';
import { BetaBandit } from './models/bandit';
import { OnlineLogReg } from './models/logreg';
import {
  loadBandit,
  loadRecommendModel,
  saveBandit,
  saveRecommendModel,
} from './persistence';
import { clamp } from './math';

const FEATURE_COUNT = RECOMMEND_FEATURE_NAMES.length;
const CANDIDATE_POOL = 80;
const MAX_SUGGESTIONS = 5;
const COLD_START_FRECENCY_FLOOR = 5;

let cachedModel: OnlineLogReg | null = null;
let cachedBandit: BetaBandit | null = null;

async function getModel(): Promise<OnlineLogReg> {
  if (!cachedModel) cachedModel = await loadRecommendModel(FEATURE_COUNT);
  return cachedModel;
}

async function getBandit(): Promise<BetaBandit> {
  if (!cachedBandit) cachedBandit = await loadBandit('recommend');
  return cachedBandit;
}

function banditArmId(domain: string): string {
  return domain;
}

async function topSitesPool(): Promise<DomainStats[]> {
  if (!chrome?.topSites?.get) return [];
  return new Promise((resolve) => {
    try {
      chrome.topSites.get((sites) => {
        const now = Date.now();
        const seen = new Set<string>();
        const out: DomainStats[] = [];
        for (const s of sites ?? []) {
          const domain = extractDomain(s.url);
          if (!domain || seen.has(domain)) continue;
          seen.add(domain);
          out.push({
            domain,
            visitCount: 1,
            visitsDecay: 0.5,
            totalFocusMs: 0,
            avgFocusMs: 0,
            closeWithoutFocusCount: 0,
            closeQuickCount: 0,
            hourDist: new Array(24).fill(0),
            dowDist: new Array(7).fill(0),
            lastVisit: now,
            updatedAt: now,
          });
        }
        resolve(out);
      });
    } catch {
      resolve([]);
    }
  });
}

async function lastEventForDomain(
  domain: string,
): Promise<{ url?: string; title?: string }> {
  const events = await db.events
    .where('[domain+ts]')
    .between([domain, 0], [domain, Date.now()], true, true)
    .reverse()
    .limit(40)
    .toArray();
  let url: string | undefined;
  let title: string | undefined;
  for (const e of events) {
    if ((e.type === 'open' || e.type === 'navigate') && e.url && !url) {
      url = e.url;
    }
    if (e.title && !title) {
      title = e.title;
    }
    if (url && title) break;
  }
  return { url, title };
}

function fallbackTitle(url: string, domain: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return domain;
  }
}

export interface RecommendCallContext extends RecommendationContext {
  pinnedDomains?: string[];
}

export async function recommendOpen(
  context: RecommendCallContext,
): Promise<OpenCandidate[]> {
  const model = await getModel();
  const bandit = await getBandit();
  const embedding = await getEmbedding();

  let pool = await getTopDomainsByFrecency(CANDIDATE_POOL);
  let isColdStart = false;
  if (pool.length < COLD_START_FRECENCY_FLOOR) {
    isColdStart = true;
    const seen = new Set(pool.map((p) => p.domain));
    const fallbacks = await topSitesPool();
    for (const f of fallbacks) {
      if (!seen.has(f.domain)) {
        pool.push(f);
        seen.add(f.domain);
      }
    }
  }
  const openSet = new Set(context.openDomains);
  const pinnedSet = new Set(context.pinnedDomains ?? []);

  const candidates: OpenCandidate[] = [];
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    const stat = pool[i];
    if (!stat.domain || stat.domain.startsWith('chrome')) continue;
    const embedSim = context.focusedDomain
      ? embedding.cosine(stat.domain, context.focusedDomain)
      : 0;
    const [vel, sess] = await Promise.all([
      visitVelocity(stat.domain, now),
      sessionContextFeature(stat.domain, now),
    ]);
    const features = await buildRecommendFeatures({
      domain: stat.domain,
      context,
      isCurrentlyOpen: openSet.has(stat.domain),
      isPinnedSomewhere: pinnedSet.has(stat.domain),
      embedSimToFocused: embedSim,
      visitVelocity: vel,
      sessionContext: sess,
      now,
    });
    if (features.isCurrentlyOpen) continue;
    const baseScore = model.predict(vectorFromRecommend(features));
    const banditMul = bandit.sample(banditArmId(stat.domain));
    let score = baseScore * (0.5 + banditMul);
    // During cold start the model and the bandit are both basically uniform,
    // so blend in topSites' own popularity order to give a sensible default.
    if (isColdStart) {
      const positionBoost = 1 - i / Math.max(pool.length, 1);
      score = score * 0.4 + positionBoost * 0.6;
    }
    const last = await lastEventForDomain(stat.domain);
    const url = last.url ?? `https://${stat.domain}`;
    const title = last.title ?? fallbackTitle(url, stat.domain);
    const reason = isColdStart && features.freqDecay <= 0.5
      ? 'popular'
      : summarizeOpenReason(features);
    candidates.push({
      domain: stat.domain,
      url,
      title,
      features,
      score: clamp(score, 0, 1),
      reason,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_SUGGESTIONS);
}

export async function recordRecommendImpressions(
  candidates: OpenCandidate[],
): Promise<void> {
  const bandit = await getBandit();
  for (const c of candidates) bandit.recordImpression(banditArmId(c.domain));
  await saveBandit('recommend', bandit);
}

export async function trainRecommendFeedback(
  domain: string,
  features: RecommendFeatures,
  action: 'accepted' | 'dismissed' | 'ignored',
): Promise<void> {
  const model = await getModel();
  const bandit = await getBandit();
  const label = action === 'accepted' ? 1 : 0;
  const weight = action === 'ignored' ? 0.3 : 1;
  model.update(vectorFromRecommend(features), label, weight);
  if (action === 'accepted') bandit.recordAccept(banditArmId(domain));
  else if (action === 'dismissed') bandit.recordDismiss(banditArmId(domain));
  else bandit.recordIgnore(banditArmId(domain), 0.3);

  await db.feedback.add({
    ts: Date.now(),
    surface: 'open',
    action,
    domain,
    features: features as unknown as Record<string, number>,
  });

  await saveRecommendModel(model);
  await saveBandit('recommend', bandit);
}

// Implicit positive: any time the user opens (or navigates to) a domain after
// the recommendation surface was rendered, treat it as a soft positive label
// for that domain in this context.
export async function trainImplicitOpen(event: TabEvent): Promise<void> {
  if (!event.domain) return;
  if (event.type !== 'open' && event.type !== 'navigate') return;
  const model = await getModel();
  const features = await buildRecommendFeatures({
    domain: event.domain,
    context: {
      hour: event.hourOfDay ?? new Date().getHours(),
      dow: event.dayOfWeek ?? new Date().getDay(),
      focusedDomain: undefined,
      openDomains: [],
    },
    isCurrentlyOpen: true,
    isPinnedSomewhere: false,
    now: event.ts,
  });
  model.update(vectorFromRecommend(features), 1, 0.2);
  await saveRecommendModel(model);
}

export function clearRecommendCaches(): void {
  cachedModel = null;
  cachedBandit = null;
}
