// ============================================
// 🧪 AI SIGNAL BACKTESTING ENGINE
// ============================================
// Validates AI signal accuracy by comparing predicted moves against actual price action.

export async function backtestSignal(symbol, prediction, actualMove, timeframe = '1d') {
  /**
   * @param {string} symbol - Asset symbol
   * @param {number} prediction - Predicted % change (e.g. 2.5 for +2.5%)
   * @param {number} actualMove - Actual % change observed
   * @param {string} timeframe - Timeframe of the signal
   */

  const directionMatch = (prediction > 0 && actualMove > 0) || (prediction < 0 && actualMove < 0);
  const magnitudeError = Math.abs(prediction - actualMove);

  let score = 0;
  if (directionMatch) score += 50;
  if (magnitudeError < 1.0) score += 30;
  else if (magnitudeError < 2.5) score += 15;

  // Edge case: Both are near zero (Flat prediction)
  if (Math.abs(prediction) < 0.5 && Math.abs(actualMove) < 0.5) score = 100;

  return {
    symbol,
    prediction,
    actualMove,
    score,
    directionMatch,
    magnitudeError,
    accuracy: `${score}%`,
    verdict: score >= 80 ? 'EXCELLENT' : score >= 50 ? 'GOOD' : 'POOR'
  };
}

export function calculateBacktestMetrics(results) {
  if (results.length === 0) return { avgAccuracy: 0, winRate: 0 };

  const totalScore = results.reduce((sum, r) => sum + r.score, 0);
  const wins = results.filter(r => r.directionMatch).length;

  return {
    avgAccuracy: (totalScore / results.length).toFixed(2) + '%',
    winRate: ((wins / results.length) * 100).toFixed(2) + '%',
    sampleSize: results.length
  };
}
