// The circuit breaker for the requests a tool call makes to Wakeshift.
// After
// callBreaker.failures of them in a row failed (no answer, a timeout, a
// 5xx), the next ones are skipped for callBreaker.coolDownMs: the tool call
// goes on as it would without Wakeshift, at no added latency. Then one
// request goes through to probe; while it's out, the others are still
// skipped. Its success closes the breaker; its failure opens it again.
// Requests outside tool calls (emits, watches) never pass through it.

/** @internal The breaker's settings (tests shorten them). */
export const callBreaker = { failures: 5, coolDownMs: 30_000 };

/** @internal What a request's outcome counts as: a failure, a success (the core answered), or neither (the caller's own abort). */
export type Outcome = "failed" | "ok" | "neither";

/** @internal One client's breaker. */
export class Breaker {
  /** @internal The clock (tests replace it). */
  now: () => number = () => Date.now();
  private failed = 0;
  private openUntil = 0;
  private probing = false;

  /** Whether a request may go: "go" while closed, "probe" for the one after the cool-down, "skip" while open. */
  admit(): "go" | "probe" | "skip" {
    if (this.failed < callBreaker.failures) return "go";
    if (this.probing || this.now() < this.openUntil) return "skip";
    this.probing = true;
    return "probe";
  }

  /** Whether it's open (skipping, or due a probe), without admitting anything. */
  get open(): boolean {
    return this.failed >= callBreaker.failures;
  }

  /** Records a request's outcome; admitted is what admit said for it. */
  done(admitted: "go" | "probe", outcome: Outcome): void {
    if (admitted === "probe") this.probing = false;
    if (outcome === "neither") return;
    // Once open, only the probe decides: a request admitted before it opened
    // and answered after neither closes it nor extends the cool-down.
    if (admitted === "go" && this.failed >= callBreaker.failures) return;
    if (outcome === "ok") {
      this.failed = 0;
      return;
    }
    this.failed++;
    if (this.failed >= callBreaker.failures) this.openUntil = this.now() + callBreaker.coolDownMs;
  }
}
