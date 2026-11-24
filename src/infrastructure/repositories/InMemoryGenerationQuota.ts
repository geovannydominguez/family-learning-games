import type {
  GenerationQuota,
  GenerationQuotaOutcome,
  GenerationQuotaReservation,
} from "../../application/game/GenerationQuota.ts";

/**
 * v0.9.3 test/local double of the global daily generation quota. The check and
 * the increment run in one synchronous step, so concurrent `reserve()` calls
 * on the single-threaded event loop behave like DynamoDB's serialized
 * conditional write: at most `limit` reservations per period.
 */
export class InMemoryGenerationQuota implements GenerationQuota {
  private readonly counters = new Map<string, number>();
  /** Every reservation request received, for assertions. */
  readonly requests: GenerationQuotaReservation[] = [];

  async reserve(reservation: GenerationQuotaReservation): Promise<GenerationQuotaOutcome> {
    this.requests.push({ ...reservation });
    const used = this.counters.get(reservation.periodKey) ?? 0;
    if (used >= reservation.limit) return { status: "exhausted", used };
    this.counters.set(reservation.periodKey, used + 1);
    return { status: "reserved", used: used + 1 };
  }

  used(periodKey: string): number {
    return this.counters.get(periodKey) ?? 0;
  }
}
