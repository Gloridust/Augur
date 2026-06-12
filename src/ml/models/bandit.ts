import { sampleBeta } from '../math';

// Beta–Bernoulli Thompson sampling per "arm" (here: a user-recognizable bucket
// like a domain or a (domain, recommendation_kind) pair). Combines a model
// score with a posterior over user-acceptance to balance exploitation and
// exploration. This is what makes "user keeps ignoring this suggestion" turn
// into "stop suggesting it" without any hand-coded rules.

export interface BanditArm {
  alpha: number;
  beta: number;
  impressions: number;
  acceptances: number;
}

export interface BanditState {
  arms: Record<string, BanditArm>;
  priorAlpha: number;
  priorBeta: number;
}

export class BetaBandit {
  state: BanditState;

  constructor(state?: BanditState) {
    this.state = state ?? { arms: {}, priorAlpha: 1, priorBeta: 1 };
  }

  serialize(): BanditState {
    return this.state;
  }

  private getArm(id: string): BanditArm {
    let arm = this.state.arms[id];
    if (!arm) {
      arm = {
        alpha: this.state.priorAlpha,
        beta: this.state.priorBeta,
        impressions: 0,
        acceptances: 0,
      };
      this.state.arms[id] = arm;
    }
    return arm;
  }

  // Draw a posterior sample for the arm. Combine multiplicatively with the
  // model score: blended = modelScore * banditSample.
  sample(id: string): number {
    const a = this.getArm(id);
    return sampleBeta(a.alpha, a.beta);
  }

  meanAccept(id: string): number {
    const a = this.getArm(id);
    return a.alpha / (a.alpha + a.beta);
  }

  recordImpression(id: string): void {
    this.getArm(id).impressions += 1;
  }

  recordAccept(id: string): void {
    const a = this.getArm(id);
    a.alpha += 1;
    a.acceptances += 1;
  }

  recordDismiss(id: string): void {
    const a = this.getArm(id);
    a.beta += 1;
  }

  // Soft negative when an impression goes unconsumed for long enough that we
  // count it as ignored.
  recordIgnore(id: string, weight = 0.25): void {
    const a = this.getArm(id);
    a.beta += weight;
  }

  // Fractional positive — used for implicit signals that are weaker than an
  // explicit accept (e.g. "user dwelled on this domain for over a minute
  // after opening it", which suggests the open was worthwhile). Does not
  // increment the `acceptances` counter, which stays reserved for explicit
  // user actions so the debug panel's accept-rate stays interpretable.
  recordSoftAccept(id: string, weight = 0.3): void {
    const a = this.getArm(id);
    a.alpha += weight;
  }
}
