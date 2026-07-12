/** Daily P/L goal progress — purely a display computation, confirmed with
 * the user to be informational only. Nothing reacts to hitting or missing
 * it; no Settings/RuntimeState field is gated on the result. Pure, no I/O. */

export interface DailyGoalInput {
  accountEquityUsd: number | null;
  dailyGoalPct: number;
  realizedPnlTodayUsd: number;
  unrealizedPnlUsd: number | null;
}

export interface DailyGoalResult {
  goalUsd: number | null;
  realizedUsd: number;
  unrealizedUsd: number | null;
  totalUsd: number;
  progressPct: number | null;
  met: boolean;
}

export function computeDailyGoalProgress(input: DailyGoalInput): DailyGoalResult {
  const goalUsd =
    input.accountEquityUsd !== null && input.accountEquityUsd > 0
      ? (input.accountEquityUsd * input.dailyGoalPct) / 100
      : null;
  const totalUsd = input.realizedPnlTodayUsd + (input.unrealizedPnlUsd ?? 0);
  const progressPct = goalUsd !== null && goalUsd > 0 ? (totalUsd / goalUsd) * 100 : null;

  return {
    goalUsd,
    realizedUsd: input.realizedPnlTodayUsd,
    unrealizedUsd: input.unrealizedPnlUsd,
    totalUsd,
    progressPct,
    met: goalUsd !== null && totalUsd >= goalUsd,
  };
}
