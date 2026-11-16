// src/core/consts.ts
var startThreshold = 0.95;
var minValidThreshold = 0.2;
var minPeaks = 15;
var requiredPeaks = minPeaks + 1;
var thresholdStep = 0.05;
var frequencyValue = 200;
var qualityValue = 1;
var minBpmRange = 90;
var maxBpmRange = 180;
var peakSkipDuration = 0.25;
var maxIntervalComparisons = 10;

// src/core/utils.ts
var thresholdDecimals = 1e9;
function thresholdLadder(minValidThreshold2, startThreshold2, thresholdStep2) {
  const rungs = [];
  const maxRungs = Math.max(1, Math.ceil(startThreshold2 / thresholdStep2));
  for (let n = 1; n <= maxRungs; n++) {
    const threshold = Math.round((startThreshold2 - n * thresholdStep2) * thresholdDecimals) / thresholdDecimals;
    rungs.push(threshold);
    if (threshold <= minValidThreshold2) {
      break;
    }
  }
  return rungs;
}
async function descendingOverThresholds(onThreshold, minValidThreshold2 = minValidThreshold, startThreshold2 = startThreshold, thresholdStep2 = thresholdStep) {
  for (const threshold of thresholdLadder(minValidThreshold2, startThreshold2, thresholdStep2)) {
    const shouldExit = await onThreshold(threshold);
    if (shouldExit) {
      break;
    }
  }
}
function computeIndexesToSkip(durationSeconds, sampleRate) {
  return Math.round(durationSeconds * sampleRate);
}

// src/core/tempo.ts
function getTopCandidates(candidates, length = 5) {
  return candidates.sort((a, b) => b.count - a.count).slice(0, length);
}
function identifyIntervals(peaks) {
  const intervals = [];
  for (let n = 0; n < peaks.length; n++) {
    for (let i = 1; i < maxIntervalComparisons; i++) {
      const peakIndex = n + i;
      if (peakIndex >= peaks.length) {
        break;
      }
      const interval = peaks[peakIndex] - peaks[n];
      const foundInterval = intervals.find(
        (intervalCount) => intervalCount.interval === interval
      );
      if (foundInterval) {
        const index = intervals.indexOf(foundInterval);
        intervals[index] = {
          interval: foundInterval.interval,
          count: foundInterval.count + 1
        };
      } else {
        intervals.push({
          interval,
          count: 1
        });
      }
    }
  }
  return intervals;
}
function resolveTempoRange(tempoRange) {
  if (tempoRange === void 0) {
    return { min: minBpmRange, max: maxBpmRange };
  }
  const min = tempoRange?.min;
  const max = tempoRange?.max;
  const isPositiveFinite = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!isPositiveFinite(min) || !isPositiveFinite(max)) {
    throw new RangeError(
      `Invalid tempoRange: min and max must be positive finite numbers (got min=${String(min)}, max=${String(max)}).`
    );
  }
  if (max < min * 2) {
    throw new RangeError(
      `Invalid tempoRange: max (${max}) must be at least twice min (${min}) so that every tempo has an octave inside the range.`
    );
  }
  return { min, max };
}
function resolveDetector(detector) {
  if (detector === void 0 || detector === "peaks" || detector === "tempogram") {
    return detector ?? "peaks";
  }
  throw new RangeError(`Invalid detector: ${String(detector)}. Use 'peaks' or 'tempogram'.`);
}
function groupByTempo({
  audioSampleRate,
  intervalCounts,
  tempoRange
}) {
  const { min, max } = resolveTempoRange(tempoRange);
  const tempoCounts = [];
  for (const intervalCount of intervalCounts) {
    if (intervalCount.interval === 0) {
      continue;
    }
    const absoluteInterval = Math.abs(intervalCount.interval);
    let theoreticalTempo = 60 / (absoluteInterval / audioSampleRate);
    while (theoreticalTempo < min) {
      theoreticalTempo *= 2;
    }
    while (theoreticalTempo > max) {
      theoreticalTempo /= 2;
    }
    theoreticalTempo = Math.round(theoreticalTempo);
    let foundTempo = tempoCounts.find(
      (tempoCount) => tempoCount.tempo === theoreticalTempo
    );
    if (foundTempo) {
      const index = tempoCounts.indexOf(foundTempo);
      tempoCounts[index] = {
        tempo: foundTempo.tempo,
        count: foundTempo.count + intervalCount.count,
        confidence: foundTempo.confidence
      };
      foundTempo = tempoCounts[index];
    }
    if (!foundTempo) {
      const tempo = {
        tempo: theoreticalTempo,
        count: intervalCount.count,
        confidence: 0
      };
      tempoCounts.push(tempo);
    }
  }
  return withConfidence(tempoCounts);
}
function withConfidence(tempos) {
  const countByTempo = new Map(tempos.map((t) => [t.tempo, t.count]));
  const totalVotes = tempos.reduce((sum, t) => sum + t.count, 0);
  return tempos.map((t) => {
    const support = (countByTempo.get(t.tempo - 1) ?? 0) + t.count + (countByTempo.get(t.tempo + 1) ?? 0);
    return {
      tempo: t.tempo,
      count: t.count,
      confidence: totalVotes > 0 ? support / totalVotes : 0
    };
  });
}

// src/core/lowpass.ts
function lowpassCoefficients(frequency, q, sampleRate) {
  const normalised = Math.min(Math.max(frequency / (sampleRate / 2), 0), 1);
  if (normalised === 1) {
    return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  if (normalised === 0) {
    return { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  const w0 = Math.PI * normalised;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * 10 ** (q / 20));
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosW0) / 2 / a0,
    b1: (1 - cosW0) / a0,
    b2: (1 - cosW0) / 2 / a0,
    a1: -2 * cosW0 / a0,
    a2: (1 - alpha) / a0
  };
}
function applyLowpass(channelData, sampleRate, options) {
  const frequency = options?.frequencyValue ?? frequencyValue;
  const q = options?.qualityValue ?? qualityValue;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Invalid sample rate: ${sampleRate}. Sample rate must be positive.`);
  }
  if (!Number.isFinite(frequency) || !Number.isFinite(q)) {
    throw new RangeError(`Invalid filter options: frequencyValue ${frequency}, qualityValue ${q}.`);
  }
  const { b0, b1, b2, a1, a2 } = lowpassCoefficients(frequency, q, sampleRate);
  const output = new Float32Array(channelData.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < channelData.length; i += 1) {
    const x0 = channelData[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

// src/core/peak-detection.ts
function findPeaksAtThreshold({
  audioSampleRate,
  data,
  threshold,
  offset = 0
}) {
  if (threshold < 0 || threshold > 1) {
    throw new Error(
      "Invalid threshold: " + threshold + ". Threshold must be between 0 and 1."
    );
  }
  if (audioSampleRate <= 0) {
    throw new Error(
      "Invalid sample rate: " + audioSampleRate + ". Sample rate must be positive."
    );
  }
  const peaks = [];
  const skipForwardIndexes = computeIndexesToSkip(
    peakSkipDuration,
    audioSampleRate
  );
  const { length } = data;
  for (let i = offset; i < length; i += 1) {
    if (data[i] > threshold) {
      peaks.push(i);
      i += skipForwardIndexes - 1;
    }
  }
  return {
    peaks,
    threshold
  };
}
async function findPeaks({
  audioSampleRate,
  channelData
}) {
  if (audioSampleRate <= 0) {
    throw new Error(
      `Invalid sample rate: ${audioSampleRate}. Sample rate must be positive.`
    );
  }
  if (!channelData || channelData.length === 0) {
    throw new Error("Invalid channel data: buffer is empty or undefined.");
  }
  let validPeaks = [];
  let validThreshold = 0;
  await descendingOverThresholds(async (threshold) => {
    const { peaks } = findPeaksAtThreshold({
      audioSampleRate,
      data: channelData,
      threshold
    });
    if (peaks.length < minPeaks) {
      return false;
    }
    validPeaks = peaks;
    validThreshold = threshold;
    return true;
  });
  return {
    peaks: validPeaks,
    threshold: validThreshold
  };
}

// src/core/detect-tempo.ts
async function detectTempo(channelData, sampleRate, tempoRange) {
  const { peaks } = await findPeaks({
    audioSampleRate: sampleRate,
    channelData
  });
  const intervals = identifyIntervals(peaks);
  const tempos = groupByTempo({
    audioSampleRate: sampleRate,
    intervalCounts: intervals,
    tempoRange
  });
  return getTopCandidates(tempos);
}

// src/core/tempogram.ts
var defaultTempogramTuning = {
  frameRate: 100,
  bands: [30, 200, 500, 1500, 4e3, 1e4],
  compression: 1e3,
  localMeanSeconds: 0.5,
  windowSeconds: 8,
  warmupSeconds: 4,
  updateSeconds: 0.5,
  combBeats: 4,
  halfLifeSeconds: 16,
  halfBeatPenalty: 0,
  thirdBeatPenalty: 0.3,
  priorBpm: 80,
  priorOctaves: 1.7,
  stableSeconds: 8,
  stableAgreement: 0.8,
  stableTolerance: 0.02,
  stableSalience: 0.15,
  stableMargin: 1.25,
  readingSalience: 0.02
};
var defaultTempogramRange = { min: 90, max: 180 };
var gridRatio = 1.01;
var loudnessDecay = 0.9995;
var minimumLoudness = 0.05;
var smoothingWeights = [1 / 9, 2 / 9, 3 / 9, 2 / 9, 1 / 9];
var maxCandidates = 5;
function createFft(size) {
  const cosines = new Float64Array(size / 2);
  const sines = new Float64Array(size / 2);
  const reversed = new Uint32Array(size);
  const bits = Math.log2(size);
  for (let i = 0; i < size / 2; i += 1) {
    cosines[i] = Math.cos(2 * Math.PI * i / size);
    sines[i] = -Math.sin(2 * Math.PI * i / size);
  }
  for (let i = 0; i < size; i += 1) {
    let value = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      value = value << 1 | i >> bit & 1;
    }
    reversed[i] = value;
  }
  return function fft(re, im) {
    for (let i = 0; i < size; i += 1) {
      const j = reversed[i];
      if (j > i) {
        const swapped = re[i];
        re[i] = re[j];
        re[j] = swapped;
        const swappedIm = im[i];
        im[i] = im[j];
        im[j] = swappedIm;
      }
    }
    for (let half = 1; half < size; half *= 2) {
      const step = size / (2 * half);
      for (let start = 0; start < size; start += 2 * half) {
        for (let k = 0; k < half; k += 1) {
          const a = start + k;
          const b = a + half;
          const wr = cosines[k * step];
          const wi = sines[k * step];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}
function createOnsetStage(sampleRate, frameRate, tuning) {
  const fftSize = 2 ** Math.round(Math.log2(0.023 * sampleRate));
  const bins = fftSize / 2;
  const fft = createFft(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const previousLog = new Float64Array(bins);
  const nyquist = sampleRate / 2;
  const edges = tuning.bands.map((hz) => Math.min(bins, Math.max(1, Math.round(hz / nyquist * bins))));
  const bandCount = edges.length - 1;
  const localMeans = new Float64Array(bandCount);
  const meanStep = 1 / (tuning.localMeanSeconds * frameRate);
  let loudness = minimumLoudness;
  let hasPrevious = false;
  function frame() {
    im.fill(0);
    fft(re, im);
    let peak = 0;
    for (let bin = 1; bin < bins; bin += 1) {
      const power = re[bin] * re[bin] + im[bin] * im[bin];
      re[bin] = power;
      peak = power > peak ? power : peak;
    }
    loudness = Math.max(Math.sqrt(peak), loudness * loudnessDecay, minimumLoudness);
    const scale = tuning.compression / loudness;
    let strength = 0;
    for (let band = 0; band < bandCount; band += 1) {
      const first = edges[band];
      const end = edges[band + 1];
      let flux = 0;
      for (let bin = first; bin < end; bin += 1) {
        const logarithm = Math.log(1 + scale * Math.sqrt(re[bin]));
        const rise = logarithm - previousLog[bin];
        previousLog[bin] = logarithm;
        flux += rise > 0 ? rise : 0;
      }
      flux /= Math.max(1, end - first);
      localMeans[band] += meanStep * (flux - localMeans[band]);
      const novelty = flux - localMeans[band];
      strength += novelty > 0 ? novelty : 0;
    }
    if (!hasPrevious) {
      hasPrevious = true;
      return 0;
    }
    return strength;
  }
  function reset() {
    previousLog.fill(0);
    localMeans.fill(0);
    loudness = minimumLoudness;
    hasPrevious = false;
  }
  return { frame, re, fftSize, reset };
}
function createTempoGrid(range, frameRate, tuning) {
  const size = Math.floor(Math.log(range.max / range.min) / Math.log(gridRatio)) + 1;
  const harmonics = tuning.combBeats;
  const tempos = new Float64Array(size);
  const prior = new Float64Array(size);
  const lags = new Float64Array(size * harmonics);
  const windowFrames = Math.round(tuning.windowSeconds * frameRate);
  let maxLag = 0;
  for (let i = 0; i < size; i += 1) {
    const tempo = range.min * gridRatio ** i;
    tempos[i] = tempo;
    prior[i] = Math.exp(-0.5 * (Math.log2(tempo / tuning.priorBpm) / tuning.priorOctaves) ** 2);
    for (let k = 0; k < harmonics; k += 1) {
      const lag = (k + 1) * 60 * frameRate / tempo;
      lags[i * harmonics + k] = lag;
      maxLag = lag < windowFrames - 1 && lag > maxLag ? lag : maxLag;
    }
  }
  return { tempos, prior, lags, harmonics, maxLag: Math.ceil(maxLag) + 1 };
}
function isLocalPeak(values, i) {
  const left = i > 0 ? values[i - 1] : Number.NEGATIVE_INFINITY;
  const right = i < values.length - 1 ? values[i + 1] : Number.NEGATIVE_INFINITY;
  return values[i] > 0 && values[i] >= left && values[i] >= right;
}
function createTempogramDetector({
  sampleRate,
  tempoRange,
  tuning: overrides
}) {
  const tuning = { ...defaultTempogramTuning, ...overrides };
  const hop = Math.round(sampleRate / tuning.frameRate);
  const frameRate = sampleRate / hop;
  const onset = createOnsetStage(sampleRate, frameRate, tuning);
  const grid = createTempoGrid(tempoRange ?? defaultTempogramRange, frameRate, tuning);
  const { fftSize } = onset;
  const hann = Float64Array.from({ length: fftSize }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / fftSize));
  const samplesRing = new Float32Array(fftSize);
  const windowFrames = Math.round(tuning.windowSeconds * frameRate);
  const ossRing = new Float32Array(2 * windowFrames);
  const recent = new Float64Array(smoothingWeights.length);
  const centred = new Float64Array(windowFrames);
  const autocorrelation = new Float64Array(grid.maxLag + 1);
  const salience = new Float64Array(grid.tempos.length);
  const accumulated = new Float64Array(grid.tempos.length);
  const ranking = new Float64Array(grid.tempos.length);
  const updateFrames = Math.max(1, Math.round(tuning.updateSeconds * frameRate));
  const warmupFrames = Math.round(tuning.warmupSeconds * frameRate);
  const memory = 0.5 ** (tuning.updateSeconds / tuning.halfLifeSeconds);
  const agreementFrames = Math.max(1, Math.round(tuning.stableSeconds / tuning.updateSeconds));
  const frameTempos = new Float64Array(agreementFrames);
  let samplesWritten = 0;
  let sinceHop = 0;
  let frames = 0;
  let accumulatedWeight = 0;
  let tempogramFrames = 0;
  let stableTempo = 0;
  function computeOnsetStrength() {
    const { re } = onset;
    const position = samplesWritten % fftSize;
    for (let i = 0; i < fftSize; i += 1) {
      re[i] = samplesRing[(position + i) % fftSize] * hann[i];
    }
    return onset.frame();
  }
  function ingest(onsetStrength) {
    recent[frames % recent.length] = onsetStrength;
    let strength = 0;
    for (let i = 0; i < recent.length; i += 1) {
      strength += recent[(frames + recent.length - i) % recent.length] * smoothingWeights[i];
    }
    const slot = frames % windowFrames;
    ossRing[slot] = strength;
    ossRing[slot + windowFrames] = strength;
    frames += 1;
    return frames >= warmupFrames && (frames - warmupFrames) % updateFrames === 0 ? tempogramFrame() : null;
  }
  function correlationAt(lag) {
    const low = Math.floor(lag);
    return autocorrelation[low] + (lag - low) * (autocorrelation[low + 1] - autocorrelation[low]);
  }
  function computeSalience() {
    const length = Math.min(frames, windowFrames);
    const first = frames <= windowFrames ? 0 : frames % windowFrames;
    let mean = 0;
    for (let i = 0; i < length; i += 1) {
      mean += ossRing[first + i];
    }
    mean /= length;
    for (let i = 0; i < length; i += 1) {
      centred[i] = ossRing[first + i] - mean;
    }
    const lagEnd = Math.min(grid.maxLag, length - 1);
    for (let lag = 0; lag <= lagEnd; lag += 1) {
      let sum = 0;
      for (let i = lag; i < length; i += 1) {
        sum += centred[i] * centred[i - lag];
      }
      autocorrelation[lag] = sum * length / (length - lag);
    }
    const energy = autocorrelation[0];
    if (energy < 1e-12) {
      return false;
    }
    const { lags, harmonics } = grid;
    for (let i = 0; i < salience.length; i += 1) {
      let sum = 0;
      let weight = 0;
      for (let k = 0; k < harmonics; k += 1) {
        const lag = lags[i * harmonics + k];
        if (lag >= lagEnd) {
          break;
        }
        sum += correlationAt(lag);
        weight += 1;
      }
      const comb = weight > 0 ? sum / (weight * energy) : 0;
      const beat = lags[i * harmonics];
      const between = tuning.halfBeatPenalty * correlationAt(beat / 2) + tuning.thirdBeatPenalty * correlationAt(beat / 3);
      salience[i] = comb - (between > 0 ? between : 0) / energy;
    }
    return true;
  }
  function bestOf(values) {
    let best = -1;
    let bestValue = 0;
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i] * grid.prior[i];
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    }
    return best;
  }
  function accumulate() {
    accumulatedWeight = accumulatedWeight * memory + 1;
    for (let i = 0; i < accumulated.length; i += 1) {
      const positive = salience[i] > 0 ? salience[i] : 0;
      accumulated[i] = accumulated[i] * memory + positive;
      ranking[i] = accumulated[i] / accumulatedWeight * grid.prior[i];
    }
  }
  function refinedTempo(i) {
    if (i === 0 || i === ranking.length - 1) {
      return grid.tempos[i];
    }
    const denominator = ranking[i - 1] - 2 * ranking[i] + ranking[i + 1];
    const offset = denominator === 0 ? 0 : 0.5 * (ranking[i - 1] - ranking[i + 1]) / denominator;
    return grid.tempos[i] * gridRatio ** offset;
  }
  function collectCandidates() {
    const peaks = [];
    for (let i = 0; i < ranking.length; i += 1) {
      if (isLocalPeak(ranking, i)) {
        peaks.push(i);
      }
    }
    return peaks.sort((a, b) => ranking[b] - ranking[a]).slice(0, maxCandidates).map((i) => ({
      tempo: Math.round(refinedTempo(i)),
      count: Math.round(ranking[i] * 1e3),
      confidence: Math.min(1, accumulated[i] / accumulatedWeight)
    })).filter((candidate) => candidate.confidence >= tuning.readingSalience);
  }
  function agreesOverTime(tempo) {
    if (tempogramFrames < agreementFrames) {
      return false;
    }
    let agreeing = 0;
    for (let i = 0; i < agreementFrames; i += 1) {
      agreeing += Math.abs(frameTempos[i] - tempo) <= tuning.stableTolerance * tempo ? 1 : 0;
    }
    return agreeing >= tuning.stableAgreement * agreementFrames;
  }
  function tempogramFrame() {
    if (!computeSalience()) {
      frameTempos[tempogramFrames % agreementFrames] = 0;
      tempogramFrames += 1;
      stableTempo = 0;
      return { candidates: [], isNewlyStable: false };
    }
    const frameBest = bestOf(salience);
    frameTempos[tempogramFrames % agreementFrames] = frameBest < 0 ? 0 : grid.tempos[frameBest];
    tempogramFrames += 1;
    accumulate();
    const candidates = collectCandidates();
    const top = candidates[0];
    const rival = candidates[1];
    const isStable = top !== void 0 && top.confidence >= tuning.stableSalience && (rival === void 0 || top.count >= tuning.stableMargin * rival.count) && agreesOverTime(top.tempo);
    const isSameTempo = isStable && Math.abs(top.tempo - stableTempo) <= tuning.stableTolerance * top.tempo;
    const isNewlyStable = isStable && !isSameTempo;
    if (isNewlyStable) {
      stableTempo = top.tempo;
    }
    return { candidates, isNewlyStable };
  }
  function process(samples) {
    let reading = null;
    for (let i = 0; i < samples.length; i += 1) {
      samplesRing[samplesWritten % fftSize] = samples[i];
      samplesWritten += 1;
      sinceHop += 1;
      if (sinceHop === hop) {
        sinceHop = 0;
        const next = ingest(computeOnsetStrength());
        if (next) {
          reading = reading?.isNewlyStable ? { ...next, isNewlyStable: true } : next;
        }
      }
    }
    return reading;
  }
  function onsetCurve(samples) {
    const curve = new Float32Array(Math.floor(samples.length / hop));
    for (let i = 0; i < samples.length; i += 1) {
      samplesRing[samplesWritten % fftSize] = samples[i];
      samplesWritten += 1;
      if (samplesWritten % hop === 0) {
        curve[samplesWritten / hop - 1] = computeOnsetStrength();
      }
    }
    return curve;
  }
  function reset() {
    onset.reset();
    samplesRing.fill(0);
    ossRing.fill(0);
    recent.fill(0);
    accumulated.fill(0);
    frameTempos.fill(0);
    samplesWritten = 0;
    sinceHop = 0;
    frames = 0;
    accumulatedWeight = 0;
    tempogramFrames = 0;
    stableTempo = 0;
  }
  return {
    candidates: collectCandidates,
    process,
    ingest,
    onsetCurve,
    progress: () => Math.min(1, frames / warmupFrames),
    reset
  };
}
var shortestRecordingSeconds = 1.5;
function detectTempogram(channelData, sampleRate, tempoRange) {
  const range = resolveTempoRange(tempoRange);
  const { frameRate, warmupSeconds } = defaultTempogramTuning;
  if (!Number.isFinite(sampleRate) || sampleRate < frameRate) {
    throw new RangeError(`Invalid sample rate: ${sampleRate}. The tempogram needs at least ${frameRate} Hz.`);
  }
  const seconds = channelData.length / sampleRate;
  if (seconds < shortestRecordingSeconds) {
    return [];
  }
  const detector = createTempogramDetector({
    sampleRate,
    tempoRange: range,
    tuning: {
      halfLifeSeconds: Number.POSITIVE_INFINITY,
      // A frame short of the end: rounding must not ask for more frames than the file holds
      warmupSeconds: Math.min(warmupSeconds, seconds - 1 / frameRate)
    }
  });
  detector.process(channelData);
  return detector.candidates();
}

// src/node.ts
async function analyzeChannelData(channelData, sampleRate, options) {
  if (!(channelData instanceof Float32Array) || channelData.length === 0) {
    throw new Error("Invalid channel data: expected a non-empty Float32Array.");
  }
  if (resolveDetector(options?.detector) === "tempogram") {
    return detectTempogram(channelData, sampleRate, options?.tempoRange);
  }
  const tempoRange = resolveTempoRange(options?.tempoRange);
  const filtered = applyLowpass(channelData, sampleRate, options);
  return detectTempo(filtered, sampleRate, tempoRange);
}
export {
  analyzeChannelData,
  applyLowpass
};
//# sourceMappingURL=node.mjs.map
