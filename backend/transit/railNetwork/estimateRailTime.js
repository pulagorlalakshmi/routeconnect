// Illustrative rail travel-time RANGE from mapped distance and a documented, assumed model (railNetworkConfig.js).
// Pure and deterministic: the same corridor always gives the same range. It contains no clock time, no train identity
// and no claim that any train runs: it answers "roughly how long would a train take on this track, if one ran".
const round5 = minutes => Math.max(5, Math.round(minutes / 5) * 5);

/**
 * @param corridor { kmByClass: { main, branch, unknown }, km, intermediateStations: number, reversals: number }
 * @param model    estimateModel()
 */
export function estimateRailTime(corridor, model) {
  const main = (corridor.kmByClass.main ?? 0) + (corridor.kmByClass.unknown ?? 0); // unknown usage is costed as main line
  const branch = corridor.kmByClass.branch ?? 0;
  const reversalMinutes = corridor.reversals * model.reversalMinutes;

  const fastRunning = (main / model.faster.mainKph + branch / model.faster.branchKph) * 60;
  const fastStops = Math.floor(corridor.km / model.faster.stopEveryKm);
  const fastStopMinutes = fastStops * model.faster.stopMinutes;

  const slowRunning = (main / model.slower.mainKph + branch / model.slower.branchKph) * 60;
  const slowStopMinutes = corridor.intermediateStations * model.slower.stopMinutesPerStation;

  const minMinutes = round5(fastRunning + fastStopMinutes + reversalMinutes);
  const maxMinutes = Math.max(minMinutes, round5(slowRunning + slowStopMinutes + reversalMinutes));
  return {
    minMinutes,
    maxMinutes,
    breakdown: {
      faster: { runningMinutes: Math.round(fastRunning), stops: fastStops, stopMinutes: fastStopMinutes, mainKph: model.faster.mainKph, branchKph: model.faster.branchKph },
      slower: { runningMinutes: Math.round(slowRunning), stops: corridor.intermediateStations, stopMinutes: Math.round(slowStopMinutes), mainKph: model.slower.mainKph, branchKph: model.slower.branchKph },
      reversals: corridor.reversals,
      reversalMinutes
    }
  };
}
