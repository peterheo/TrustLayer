/**
 * The verification protocol as explicit, host-owned state.
 *
 * The receipt asserts that a contradiction search happened, that sources were
 * fetched, that citations were validated. Those assertions are only worth
 * something if the model cannot make them, so they are recorded here — by the
 * driver, as it observes real tool results — and read back when the receipt is
 * built.
 *
 * PLAN -> DISCOVER -> FETCH -> CHALLENGE -> ADJUDICATE, then the host's own
 * VALIDATE and RECEIPT phases outside the turn.
 */

export const PHASES = [
  "plan",
  "discover",
  "fetch",
  "challenge",
  "adjudicate",
  "validate",
  "receipt",
] as const;

export type Phase = (typeof PHASES)[number];

/** Tool activity actually observed, per phase. */
interface PhaseActivity {
  searchCalls: number;
  searchSucceeded: number;
  fetchCalls: number;
  fetchSucceeded: number;
}

function emptyActivity(): PhaseActivity {
  return { searchCalls: 0, searchSucceeded: 0, fetchCalls: 0, fetchSucceeded: 0 };
}

export class ProtocolState {
  #phase: Phase = "plan";
  readonly #entered = new Set<Phase>(["plan"]);
  readonly #completed = new Set<Phase>();
  readonly #activity = new Map<Phase, PhaseActivity>();
  readonly #failures: string[] = [];

  get phase(): Phase {
    return this.#phase;
  }

  enter(phase: Phase): void {
    this.#phase = phase;
    this.#entered.add(phase);
  }

  complete(phase: Phase): void {
    this.#completed.add(phase);
  }

  entered(phase: Phase): boolean {
    return this.#entered.has(phase);
  }

  completed(phase: Phase): boolean {
    return this.#completed.has(phase);
  }

  /** Note that a phase could not finish, with a short reason for the receipt. */
  fail(phase: Phase, reason: string): void {
    this.#failures.push(`${phase}: ${reason}`);
  }

  get failures(): readonly string[] {
    return this.#failures;
  }

  /** Record one observed tool result, attributed to the phase it happened in. */
  recordToolResult(tool: string, succeeded: boolean): void {
    const activity = this.#activity.get(this.#phase) ?? emptyActivity();
    if (tool.endsWith(".search")) {
      activity.searchCalls += 1;
      if (succeeded) activity.searchSucceeded += 1;
    } else if (tool.endsWith(".fetch")) {
      activity.fetchCalls += 1;
      if (succeeded) activity.fetchSucceeded += 1;
    }
    this.#activity.set(this.#phase, activity);
  }

  activityIn(phase: Phase): Readonly<PhaseActivity> {
    return this.#activity.get(phase) ?? emptyActivity();
  }

  private totalWhere(select: (activity: PhaseActivity) => number): number {
    let total = 0;
    for (const activity of this.#activity.values()) total += select(activity);
    return total;
  }

  get totalSearchesSucceeded(): number {
    return this.totalWhere((activity) => activity.searchSucceeded);
  }

  get totalFetchesSucceeded(): number {
    return this.totalWhere((activity) => activity.fetchSucceeded);
  }

  get totalToolCalls(): number {
    return this.totalWhere(
      (activity) => activity.searchCalls + activity.fetchCalls,
    );
  }

  /**
   * A contradiction search counts only if the challenge phase was actually
   * entered and a search succeeded while it was current.
   *
   * Entering the phase is not enough, and neither is the model saying it
   * looked: the evidence is a successful search tool result recorded under the
   * challenge phase.
   */
  get contradictionSearchPerformed(): boolean {
    return this.entered("challenge") && this.activityIn("challenge").searchSucceeded > 0;
  }

  get independentSearchPerformed(): boolean {
    return this.totalSearchesSucceeded > 0;
  }

  get sourcesFetched(): boolean {
    return this.totalFetchesSucceeded > 0;
  }
}
