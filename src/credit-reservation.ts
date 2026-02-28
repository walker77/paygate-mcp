/**
 * CreditReservationManager — Pre-authorize credits before execution.
 *
 * Reserve credits for expensive or long-running tool calls,
 * then settle (consume) or release (refund) after completion.
 * Prevents double-spending and runaway costs.
 *
 * @example
 * ```ts
 * const reservations = new CreditReservationManager();
 * reservations.setBalance('key_abc', 1000);
 *
 * // Reserve 50 credits before a tool call
 * const res = reservations.reserve({ key: 'key_abc', amount: 50, tool: 'generate' });
 *
 * // After tool call completes, settle the actual cost
 * reservations.settle(res.id, 35); // only used 35 credits
 *
 * // Or release if the call failed
 * reservations.release(res.id);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type ReservationStatus = 'held' | 'settled' | 'released' | 'expired';

export interface Reservation {
  id: string;
  key: string;
  amount: number;
  settledAmount?: number;
  tool?: string;
  status: ReservationStatus;
  createdAt: number;
  expiresAt: number;
  settledAt?: number;
  releasedAt?: number;
  note?: string;
}

export interface ReserveParams {
  key: string;
  amount: number;
  tool?: string;
  /** TTL in seconds. Default 300 (5 minutes). */
  ttlSeconds?: number;
  note?: string;
}

export interface ReserveResult {
  id: string;
  success: boolean;
  error?: string;
  availableBalance: number;
  heldBalance: number;
}

export interface CreditReservationConfig {
  defaultTtlSeconds?: number;
  maxReservationsPerKey?: number;
  maxReservationAmount?: number;
  autoExpireIntervalMs?: number;
}

export interface CreditReservationStats {
  totalReservations: number;
  activeReservations: number;
  totalSettled: number;
  totalReleased: number;
  totalExpired: number;
  totalCreditsHeld: number;
  totalCreditsSettled: number;
  totalCreditsReleased: number;
  trackedKeys: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class CreditReservationManager {
  private balances = new Map<string, number>();
  private reservations = new Map<string, Reservation>();
  private defaultTtlSeconds: number;
  private maxReservationsPerKey: number;
  private maxReservationAmount: number;
  private idCounter = 0;
  private expireTimer: ReturnType<typeof setInterval> | null = null;

  // Stats
  private totalCreated = 0;
  private totalSettled = 0;
  private totalReleased = 0;
  private totalExpired = 0;
  private totalCreditsSettled = 0;
  private totalCreditsReleased = 0;

  constructor(config: CreditReservationConfig = {}) {
    this.defaultTtlSeconds = config.defaultTtlSeconds ?? 300;
    this.maxReservationsPerKey = config.maxReservationsPerKey ?? 50;
    this.maxReservationAmount = config.maxReservationAmount ?? Infinity;

    // Auto-expire timer
    const intervalMs = config.autoExpireIntervalMs ?? 30_000;
    if (intervalMs > 0) {
      this.expireTimer = setInterval(() => this.expireReservations(), intervalMs);
      if (this.expireTimer.unref) this.expireTimer.unref();
    }
  }

  // ── Balance Management ──────────────────────────────────────────────

  /** Set balance for a key. */
  setBalance(key: string, amount: number): void {
    this.balances.set(key, amount);
  }

  /** Get total balance for a key. */
  getBalance(key: string): number {
    return this.balances.get(key) ?? 0;
  }

  /** Get available balance (total - held). */
  getAvailableBalance(key: string): number {
    const total = this.getBalance(key);
    const held = this.getHeldBalance(key);
    return total - held;
  }

  /** Get total held (reserved) balance for a key. */
  getHeldBalance(key: string): number {
    let held = 0;
    for (const r of this.reservations.values()) {
      if (r.key === key && r.status === 'held') held += r.amount;
    }
    return held;
  }

  // ── Reserve / Settle / Release ─────────────────────────────────────

  /** Reserve credits for a future tool call. */
  reserve(params: ReserveParams): ReserveResult {
    const { key, amount, tool, note } = params;
    const ttl = params.ttlSeconds ?? this.defaultTtlSeconds;
    const id = `res_${++this.idCounter}`;

    // Validation
    if (amount <= 0) {
      return { id, success: false, error: 'amount must be positive', availableBalance: this.getAvailableBalance(key), heldBalance: this.getHeldBalance(key) };
    }
    if (amount > this.maxReservationAmount) {
      return { id, success: false, error: `amount exceeds max reservation (${this.maxReservationAmount})`, availableBalance: this.getAvailableBalance(key), heldBalance: this.getHeldBalance(key) };
    }

    // Check per-key reservation limit
    const keyReservations = this.getActiveReservations(key);
    if (keyReservations.length >= this.maxReservationsPerKey) {
      return { id, success: false, error: `max reservations per key reached (${this.maxReservationsPerKey})`, availableBalance: this.getAvailableBalance(key), heldBalance: this.getHeldBalance(key) };
    }

    // Check available balance
    const available = this.getAvailableBalance(key);
    if (available < amount) {
      return { id, success: false, error: `insufficient available balance (has ${available}, needs ${amount})`, availableBalance: available, heldBalance: this.getHeldBalance(key) };
    }

    const now = Date.now();
    const reservation: Reservation = {
      id,
      key,
      amount,
      tool,
      status: 'held',
      createdAt: now,
      expiresAt: now + ttl * 1000,
      note,
    };

    this.reservations.set(id, reservation);
    this.totalCreated++;

    return {
      id,
      success: true,
      availableBalance: this.getAvailableBalance(key),
      heldBalance: this.getHeldBalance(key),
    };
  }

  /** Settle a reservation — consume credits (actual amount may differ from reserved). */
  settle(reservationId: string, actualAmount?: number): boolean {
    const r = this.reservations.get(reservationId);
    if (!r || r.status !== 'held') return false;

    const amount = actualAmount ?? r.amount;
    if (amount < 0) return false;

    // Deduct actual amount from balance
    const balance = this.getBalance(r.key);
    this.balances.set(r.key, balance - amount);

    r.status = 'settled';
    r.settledAmount = amount;
    r.settledAt = Date.now();
    this.totalSettled++;
    this.totalCreditsSettled += amount;

    return true;
  }

  /** Release a reservation — return credits to available pool. */
  release(reservationId: string): boolean {
    const r = this.reservations.get(reservationId);
    if (!r || r.status !== 'held') return false;

    r.status = 'released';
    r.releasedAt = Date.now();
    this.totalReleased++;
    this.totalCreditsReleased += r.amount;

    return true;
  }

  // ── Query ──────────────────────────────────────────────────────────

  /** Get a reservation by ID. */
  getReservation(id: string): Reservation | null {
    return this.reservations.get(id) ?? null;
  }

  /** Get active (held) reservations for a key. */
  getActiveReservations(key: string): Reservation[] {
    const result: Reservation[] = [];
    for (const r of this.reservations.values()) {
      if (r.key === key && r.status === 'held') result.push(r);
    }
    return result;
  }

  /** Get all reservations for a key (all statuses). */
  getKeyReservations(key: string, limit?: number): Reservation[] {
    const result: Reservation[] = [];
    for (const r of this.reservations.values()) {
      if (r.key === key) result.push(r);
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return limit ? result.slice(0, limit) : result;
  }

  // ── Expiration ─────────────────────────────────────────────────────

  /** Expire all reservations past their TTL. Returns count expired. */
  expireReservations(): number {
    const now = Date.now();
    let count = 0;
    for (const r of this.reservations.values()) {
      if (r.status === 'held' && r.expiresAt <= now) {
        r.status = 'expired';
        this.totalExpired++;
        this.totalCreditsReleased += r.amount;
        count++;
      }
    }
    return count;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): CreditReservationStats {
    let activeReservations = 0;
    let totalCreditsHeld = 0;
    for (const r of this.reservations.values()) {
      if (r.status === 'held') {
        activeReservations++;
        totalCreditsHeld += r.amount;
      }
    }

    return {
      totalReservations: this.totalCreated,
      activeReservations,
      totalSettled: this.totalSettled,
      totalReleased: this.totalReleased,
      totalExpired: this.totalExpired,
      totalCreditsHeld,
      totalCreditsSettled: this.totalCreditsSettled,
      totalCreditsReleased: this.totalCreditsReleased,
      trackedKeys: this.balances.size,
    };
  }

  /** Clear all data. */
  destroy(): void {
    if (this.expireTimer) {
      clearInterval(this.expireTimer);
      this.expireTimer = null;
    }
    this.balances.clear();
    this.reservations.clear();
    this.totalCreated = 0;
    this.totalSettled = 0;
    this.totalReleased = 0;
    this.totalExpired = 0;
    this.totalCreditsSettled = 0;
    this.totalCreditsReleased = 0;
    this.idCounter = 0;
  }
}
