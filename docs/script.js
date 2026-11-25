"use strict";

// Exact calibration from the notebook's replication export and service model.
const BASE_RATE = 2.1813471502590676; // buses per hour
const MEAN_SERVICE = 55.98693586698338; // seconds
const SIGMA = 0.7759553844290873;
const HOUR = 3600;
const SPEEDS = [300, 900, HOUR, 4 * HOUR, 12 * HOUR];
const SPEED_LABELS = ["5 min", "15 min", "1 h", "4 h", "12 h"];
const VISUAL_SPEEDS = [1, 10, 30, 60];
const VISUAL_LABELS = ["1 s", "10 s", "30 s", "1 min"];
const PRESETS = { baseline: [1, 1], high1: [28, 1], high2: [28, 2], high3: [28, 3], overload: [35, 1] };
const REFERENCE = {
  theory: 28.74437909044385,
  simulated: 28.52531113700759,
  lower: 28.11567268461304,
  upper: 28.934949589402144,
  replications: 30,
  horizon: 1000 * HOUR,
  warmup: 100 * HOUR,
  theoryTolerance: 1e-8,
};
// Declare the tolerance independently of browser outcomes. 2.04523 is t(0.975, 29).
const BENCHMARK_TOLERANCE = 3 * Math.SQRT2 * (REFERENCE.upper - REFERENCE.lower) / (2 * 2.04523);

function randomStream(seed) {
  // Mulberry32, returning values strictly between zero and one.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let z = Math.imul(state ^ (state >>> 15), state | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return (((z ^ (z >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
}

function exponential(mean, random) {
  return -mean * Math.log1p(-random());
}

function serviceTime(mean, distribution, random) {
  if (distribution === "exponential") return exponential(mean, random);
  const normal = Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
  return Math.exp(Math.log(mean) - SIGMA ** 2 / 2 + SIGMA * normal);
}

function analytical({ multiplier, bays, mean }) {
  const lambda = BASE_RATE * multiplier;
  const mu = HOUR / mean;
  const offered = lambda / mu;
  const rho = lambda / (bays * mu);
  if (rho >= 1 - 8 * Number.EPSILON) return { lambda, rho, wait: null };
  let term = 1;
  let sum = 1;
  for (let n = 1; n < bays; n++) {
    term *= offered / n;
    sum += term;
  }
  const tail = term * offered / (bays * (1 - rho));
  return { lambda, rho, wait: (tail / (sum + tail)) / (bays * mu - lambda) * HOUR };
}

class BusHalt {
  constructor(config, { cutoff = Infinity, warmup = 0 } = {}) {
    this.config = { ...config };
    this.cutoff = cutoff;
    this.warmup = warmup;
    this.arrivalRandom = randomStream(config.seed);
    this.serviceRandom = randomStream(config.seed ^ 0x9E3779B9);
    this.intervalMean = HOUR / (BASE_RATE * config.multiplier);
    this.nextArrival = this.arrivalAfter(0);
    this.time = 0;
    this.lastEventTime = 0;
    this.queue = new Map();
    this.bays = Array(config.bays).fill(null);
    this.busy = 0;
    this.arrivals = 0;
    this.completed = 0;
    this.measured = 0;
    this.waited = 0;
    this.waitSum = 0;
    this.systemSum = 0;
    this.queueArea = 0;
    this.busyArea = 0;
    this.lastStarted = 0;
    this.lastArrival = null;
    this.lastDeparture = null;
    this.audit = { fcfs: true, waiting: true, conservation: true, utilisation: true };
  }

  arrivalAfter(time) {
    const next = time + exponential(this.intervalMean, this.arrivalRandom);
    return next < this.cutoff ? next : Infinity;
  }

  nextEvent() {
    let departure = Infinity;
    let bay = -1;
    for (let i = 0; i < this.bays.length; i++) {
      if (this.bays[i] && this.bays[i].departure < departure) {
        departure = this.bays[i].departure;
        bay = i;
      }
    }
    // A departure wins a tie. Within one event, starting the FIFO head is immediate.
    return departure <= this.nextArrival ? { time: departure, bay } : { time: this.nextArrival, bay: -1 };
  }

  startService(bus, bay, time) {
    bus.wait = time - bus.arrival;
    bus.departure = time + bus.service;
    this.audit.fcfs &&= bus.id === this.lastStarted + 1;
    this.audit.waiting &&= bus.wait >= 0;
    this.lastStarted = bus.id;
    this.bays[bay] = bus;
    this.busy++;
  }

  process({ time, bay }) {
    const duration = Math.max(0, Math.min(time, this.cutoff) - Math.max(this.lastEventTime, this.warmup));
    this.queueArea += this.queue.size * duration;
    this.busyArea += this.busy * duration;
    this.lastEventTime = time;
    if (bay < 0) {
      const bus = {
        id: ++this.arrivals,
        arrival: time,
        service: serviceTime(this.config.mean, this.config.distribution, this.serviceRandom),
      };
      this.lastArrival = bus.id;
      this.nextArrival = this.arrivalAfter(time);
      const available = this.bays.indexOf(null);
      if (available >= 0) this.startService(bus, available, time);
      else this.queue.set(bus.id, bus);
    } else {
      const bus = this.bays[bay];
      this.lastDeparture = bus.id;
      this.bays[bay] = null;
      this.busy--;
      this.completed++;
      if (bus.arrival >= this.warmup) {
        this.measured++;
        this.waitSum += bus.wait;
        this.systemSum += time - bus.arrival;
        this.waited += Number(bus.wait > 0);
      }
      const first = this.queue.values().next().value;
      if (first) {
        this.queue.delete(first.id);
        this.startService(first, bay, time);
      }
    }
    this.audit.conservation &&= this.arrivals === this.completed + this.busy + this.queue.size;
    this.audit.utilisation &&= this.busy >= 0 && this.busy <= this.config.bays;
  }

  advance(target, budget = Infinity) {
    let next = this.nextEvent();
    while (Number.isFinite(next.time) && next.time <= target) {
      if (budget <= 0) return false;
      this.process(next);
      this.time = next.time;
      budget--;
      next = this.nextEvent();
    }
    if (Number.isFinite(target)) this.time = target;
    return true;
  }

  stats() {
    const observedTime = Math.max(0, Math.min(this.time, this.cutoff) - this.warmup);
    const tail = Math.max(0, Math.min(this.time, this.cutoff) - Math.max(this.lastEventTime, this.warmup));
    return {
      elapsed: this.time, queued: this.queue.size, busy: this.busy,
      arrivals: this.arrivals, completed: this.completed,
      meanWait: this.measured ? this.waitSum / this.measured : null,
      meanSystem: this.measured ? this.systemSum / this.measured : null,
      averageQueue: observedTime ? (this.queueArea + tail * this.queue.size) / observedTime : null,
      utilisation: observedTime ? (this.busyArea + tail * this.busy) / (this.config.bays * observedTime) : null,
      throughput: observedTime ? this.measured * HOUR / observedTime : null,
      waitProbability: this.measured ? this.waited / this.measured : null,
    };
  }
}

function frameTarget(previous, milliseconds, speed, limit = Infinity) {
  return Math.min(limit, previous + Math.max(0, milliseconds) / 1000 * speed);
}

function auditBenchmark(model, checks) {
  for (const key of Object.keys(model.audit)) checks[key] &&= model.audit[key];
  const utilisation = model.stats().utilisation;
  checks.utilisation &&= utilisation !== null && utilisation >= 0 && utilisation <= 1 + 1e-12;
}

async function runBenchmark(onProgress = () => {}) {
  const config = { multiplier: 10, bays: 1, mean: MEAN_SERVICE, distribution: "exponential", seed: 42 };
  const checks = { fcfs: true, waiting: true, conservation: true, utilisation: true };
  let sum = 0;
  for (let i = 0; i < REFERENCE.replications; i++) {
    const seed = Math.imul(i + 1, 0x85EBCA6B) >>> 0;
    const model = new BusHalt({ ...config, seed }, { cutoff: REFERENCE.horizon, warmup: REFERENCE.warmup });
    model.advance(REFERENCE.horizon);
    auditBenchmark(model, checks);
    model.advance(Infinity); // Finish the cohort that arrived before the cutoff.
    sum += model.stats().meanWait;
    auditBenchmark(model, checks);
    checks.conservation &&= model.arrivals === model.completed;
    if ((i + 1) % 5 === 0) await onProgress(i + 1);
  }

  const stress = { ...config, multiplier: 35, distribution: "lognormal" };
  const horizon = 24 * HOUR;
  const direct = new BusHalt(stress);
  const repeat = new BusHalt(stress);
  direct.advance(horizon);
  repeat.advance(horizon);
  const snapshot = (model) => JSON.stringify([model.stats(), [...model.queue.values()], model.bays, model.nextArrival]);
  checks.reproducibility = snapshot(direct) === snapshot(repeat);
  checks.speed = [SPEEDS[0], SPEEDS.at(-1)].every((speed) => {
    const paced = new BusHalt(stress);
    while (paced.time < horizon) paced.advance(frameTarget(paced.time, 100, speed, horizon));
    return snapshot(paced) === snapshot(direct);
  });
  return { theory: analytical(config).wait, simulated: sum / REFERENCE.replications, checks };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BusHalt, analytical, runBenchmark, REFERENCE, BENCHMARK_TOLERANCE, MEAN_SERVICE, HOUR };
}

function startDashboard() {
  const $ = (id) => document.getElementById(id);
  const modelInputs = ["demand", "bays", "duration", "distribution", "seed"];
  const format = (value, digits = 2, units = "") =>
    Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: digits }) + units : "—";
  const timeLabel = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m`
      : minutes ? `${minutes} m ${Math.floor(seconds) % 60} s` : `${Math.floor(seconds)} s`;
  };
  const config = () => ({
    multiplier: Number($("demand").value), bays: Number($("bays").value),
    mean: $("duration").valueAsNumber, distribution: $("distribution").value, seed: $("seed").valueAsNumber,
  });

  let model;
  let state = "ready";
  let frame = 0;
  let lastFrame = null;
  let targetTime = 0;
  let segmentStart = 0;
  let segmentElapsed = 0;
  let playbackRate = null;
  let sampleTime = 120;
  let samples = [];
  const animation = new HaltAnimation();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const savedSpeed = { visual: 3, fast: 2 };
  let visualTime = 0;
  let lastRender = -Infinity;

  function updateTheory() {
    const valid = $("duration").validity.valid;
    const current = config();
    const result = valid ? analytical(current) : null;
    const exponentialService = current.distribution === "exponential";
    $("arrival-rate").textContent = format(BASE_RATE * current.multiplier, 2, " buses/h");
    $("load-label").textContent = result?.wait === null ? "Offered load" : "Theoretical utilisation";
    $("offered-load").textContent = format(result ? result.rho * 100 : null, 2, "%");
    $("theory-wait").textContent = format(exponentialService ? result?.wait : null, 4, " s");
    const note = $("model-note");
    note.classList.toggle("warning", result?.wait === null);
    if (!valid) note.textContent = "Enter a mean service time from 1 to 600 seconds.";
    else if (result.wait === null) note.textContent = "Critical or overloaded. Demand meets or exceeds capacity, so no finite steady-state mean queue wait exists.";
    else if (!exponentialService) note.textContent = "Lognormal service (M/G/c). The M/M/c waiting-time formula applies to exponential service only.";
    else note.textContent = "Erlang C prediction for exponential service at steady state. Live measurements start with an empty halt.";
  }

  function setState(next) {
    state = next;
    const status = $("run-state");
    status.dataset.state = next;
    status.lastChild.nodeValue = ` ${next[0].toUpperCase() + next.slice(1)}`;
    $("start").textContent = { ready: "Start", running: "Pause", paused: "Resume" }[next];
    $("start").disabled = !$("duration").validity.valid || !$("seed").validity.valid;
  }

  function reset(message) {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = null;
    lastRender = -Infinity;
    targetTime = 0;
    segmentStart = 0;
    segmentElapsed = 0;
    playbackRate = null;
    sampleTime = 120;
    samples = [{ time: 0, queued: 0, meanWait: null }];
    animation.clear();
    visualTime = 0;
    model = $("duration").validity.valid && $("seed").validity.valid ? new BusHalt(config()) : null;
    setState("ready");
    $("run-message").textContent = model ? message : "Enter a valid service duration and integer seed.";
    updateTheory();
    renderMeasurements();
    renderScene();
  }

  function animate(now) {
    if (state !== "running") return;
    if (lastFrame !== null) {
      const delta = Math.min(now - lastFrame, 100);
      visualTime += delta;
      const speeds = $("mode").value === "visual" ? VISUAL_SPEEDS : SPEEDS;
      const rate = speeds[$("speed").value];
      if (rate !== playbackRate) {
        segmentStart = targetTime;
        segmentElapsed = 0;
        playbackRate = rate;
      }
      segmentElapsed += delta;
      targetTime = frameTarget(segmentStart, segmentElapsed, rate);
      // Keep responsiveness if an unusually large workload falls into one frame.
      for (let n = 0; sampleTime <= targetTime && n < 40; n++) {
        if (!model.advance(sampleTime, 600)) break;
        const { queued, meanWait } = model.stats();
        samples.push({ time: sampleTime, queued, meanWait });
        if (samples.length > 240) samples.shift();
        sampleTime += 120;
      }
      if (sampleTime > targetTime) model.advance(targetTime, 600);
    }
    lastFrame = now;
    const visual = $("mode").value === "visual" && !reducedMotion.matches;
    if (visual) renderScene();
    if (now - lastRender >= (visual ? 65 : 85)) {
      if (!visual) renderScene();
      renderMeasurements();
      lastRender = now;
    }
    frame = requestAnimationFrame(animate);
  }

  $("start").addEventListener("click", () => {
    if (!model) return;
    if (state === "running") {
      cancelAnimationFrame(frame);
      frame = 0;
      setState("paused");
      renderMeasurements();
      renderScene();
      $("run-message").textContent = "Paused. Resume keeps the current queue and random streams.";
      return;
    }
    lastFrame = null;
    setState("running");
    $("run-message").textContent = "Running. Model changes reset the run.";
    frame = requestAnimationFrame(animate);
  });
  $("reset").addEventListener("click", () => reset("Run cleared. Start to simulate with these settings."));
  $("preset").addEventListener("change", () => {
    const preset = PRESETS[$("preset").value];
    if (!preset) return;
    [$("demand").value, $("bays").value] = preset;
    $("duration").value = MEAN_SERVICE;
    $("distribution").value = "exponential";
    reset("Preset applied. Start to run this scenario.");
  });
  for (const id of modelInputs) $(id).addEventListener("input", () => {
    $("preset").value = "custom";
    reset("Settings applied. Start to run this scenario.");
  });
  function updateSpeedHelp() {
    const visual = $("mode").value === "visual";
    const labels = visual ? VISUAL_LABELS : SPEED_LABELS;
    savedSpeed[$("mode").value] = Number($("speed").value);
    $("speed-help").textContent = `${labels[$("speed").value]} simulated per real second.`;
  }

  function populateSpeeds() {
    const visual = $("mode").value === "visual";
    const rates = visual ? VISUAL_SPEEDS : SPEEDS;
    const labels = visual ? rates.map((rate) => `${rate}×`) : SPEED_LABELS.map((label) => `${label}/s`);
    $("speed").replaceChildren(...labels.map((label, index) => new Option(label, index)));
    $("speed").value = savedSpeed[$("mode").value];
    updateSpeedHelp();
  }

  $("mode").addEventListener("change", () => {
    populateSpeeds();
    renderScene();
  });
  $("speed").addEventListener("change", updateSpeedHelp);

  function renderMeasurements() {
    const stats = model?.stats();
    const busCount = (count) => format(count, 0, count === 1 ? " bus" : " buses");
    const values = {
      elapsed: stats ? timeLabel(stats.elapsed) : "—",
      queued: busCount(stats?.queued), "in-service": busCount(stats?.busy),
      arrivals: format(stats?.arrivals, 0), completed: format(stats?.completed, 0),
      "mean-wait": format(stats?.meanWait, 2, " s"), "mean-system": format(stats?.meanSystem, 2, " s"),
      "average-queue": format(stats?.averageQueue, 3, " buses"),
      utilisation: format(stats?.utilisation == null ? null : 100 * stats.utilisation, 2, "%"),
      throughput: format(stats?.throughput, 2, " buses/h"),
      "wait-probability": format(stats?.waitProbability == null ? null : 100 * stats.waitProbability, 2, "%"),
    };
    Object.entries(values).forEach(([id, value]) => { $(id).textContent = value; });
    drawChart($("queue-chart"), samples, "queued", "#ffc16d");
    drawChart($("wait-chart"), samples, "meanWait", "#62e0c3");
  }

  function renderScene() {
    const smooth = $("mode").value === "visual" && !reducedMotion.matches;
    const hidden = drawHalt($("halt"), model, animation, visualTime, smooth);
    $("overflow").textContent = hidden ? `+${format(hidden, 0)} more waiting` : "";
  }

  $("b-tolerance").textContent = BENCHMARK_TOLERANCE.toFixed(6);
  $("verify").addEventListener("click", async () => {
    const button = $("verify");
    button.disabled = true;
    $("checks").replaceChildren();
    $("verify-message").textContent = "Running independent browser replications…";
    try {
      const outcome = await runBenchmark(async (count) => {
        $("verify-message").textContent = `Completed ${count} of ${REFERENCE.replications} replications.`;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const comparison = (id, result, expected, tolerance) => {
        const error = Math.abs(result - expected);
        const pass = Number.isFinite(error) && error <= tolerance;
        $(`${id}-value`).textContent = result.toFixed(6);
        $(`${id}-error`).textContent = error.toExponential(3);
        $(`${id}-status`).textContent = pass ? "PASS" : "FAIL";
        $(`${id}-status`).className = pass ? "pass" : "fail";
        return pass;
      };
      const a = comparison("a", outcome.theory, REFERENCE.theory, REFERENCE.theoryTolerance);
      const b = comparison("b", outcome.simulated, REFERENCE.simulated, BENCHMARK_TOLERANCE);
      const labels = {
        fcfs: "FCFS order", waiting: "Non-negative waits", conservation: "Bus conservation",
        utilisation: "Valid utilisation", reproducibility: "Seed reproducibility", speed: "Speed independence",
      };
      for (const [id, pass] of Object.entries(outcome.checks)) {
        const item = document.createElement("li");
        item.className = pass ? "pass" : "fail";
        item.textContent = `${labels[id]} · ${pass ? "PASS" : "FAIL"}`;
        $("checks").append(item);
      }
      $("verify-message").textContent = a && b && Object.values(outcome.checks).every(Boolean)
        ? "Both notebook comparisons and all simulation checks passed."
        : "At least one comparison or simulation check failed.";
    } catch (error) {
      $("verify-message").textContent = `Verification could not finish. ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  window.addEventListener("resize", () => {
    renderScene();
    renderMeasurements();
  });
  reducedMotion.addEventListener("change", renderScene);
  window.addEventListener("hashchange", () => {
    if (location.hash === "#measurement-guide") $("measurement-guide").open = true;
  });
  if (location.hash === "#measurement-guide") $("measurement-guide").open = true;
  $("duration").value = MEAN_SERVICE;
  populateSpeeds();
  reset("Model changes reset the run. Speed can change at any time.");
}

function canvasContext(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const pixelsWide = Math.round(width * scale);
  const pixelsHigh = Math.round(height * scale);
  if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
    canvas.width = pixelsWide;
    canvas.height = pixelsHigh;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function rounded(ctx, x, y, width, height, radius, fill, border) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (border) { ctx.strokeStyle = border; ctx.stroke(); }
}

function drawBus(ctx, x, y, width, id, color, height = 24) {
  ctx.fillStyle = "#070e17";
  for (const end of [.17, .72]) {
    ctx.fillRect(x + end * width, y - 2, width * .13, height + 4);
  }
  rounded(ctx, x, y, width, height, 5, color);
  rounded(ctx, x + width - 11, y + 4, 7, height - 8, 2, "#22354a");
  ctx.fillStyle = "#102033";
  ctx.font = "bold 10px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(`#${id}`, x + (width - 9) / 2, y + height / 2 + 3.5);
}

// Canvas-only state. The model never reads these interpolated positions.
class HaltAnimation {
  clear() {
    this.sprites = new Map();
    this.lastArrival = 0;
    this.size = "";
  }

  constructor() { this.clear(); }

  position(sprite, now) {
    if (!sprite.motion) return sprite.target;
    const { points, start, duration } = sprite.motion;
    const elapsed = Math.max(0, Math.min(1, (now - start) / duration));
    const progress = elapsed * elapsed * (3 - 2 * elapsed);
    const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y));
    let distance = progress * lengths.reduce((sum, length) => sum + length, 0);
    for (const [index, length] of lengths.entries()) {
      if (distance <= length && length > 0) {
        const a = points[index], b = points[index + 1], fraction = distance / length;
        return { ...sprite.target, x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
      }
      distance -= length;
    }
    return sprite.target;
  }

  update(visible, { size, lastArrival, now, smooth, corridor, tail, exit }) {
    if (size !== this.size) {
      this.clear();
      this.size = size;
      smooth = false;
    }
    const previous = this.sprites;
    const next = new Map();

    for (const item of visible) {
      const old = previous.get(item.id);
      const unchanged = old && old.target.x === item.x && old.target.y === item.y && old.target.place === item.place;
      if (!smooth || unchanged) {
        next.set(item.id, { target: item, motion: smooth ? old.motion : null });
        continue;
      }
      const origin = old ? this.position(old, now)
        : item.id > this.lastArrival ? { x: -item.width, y: tail.y }
        : item.place === "queue" ? tail : null;
      const points = origin && item.place === "bay"
        ? [origin, { x: origin.x, y: corridor }, { x: item.x, y: corridor }, item]
        : origin ? [origin, item] : null;
      const duration = item.place === "bay" ? 500 : old ? 310 : 460;
      next.set(item.id, { target: item, motion: points && { points, start: now, duration } });
    }

    if (smooth) {
      // Only a previously occupied bay can produce a departure sprite.
      // A hidden or short-lived bus can be absent from the canvas while still counted.
      for (const [id, old] of previous) {
        if (next.has(id) || old.target.place === "queue") continue;
        if (old.target.place === "exit") {
          if (now - old.motion.start < old.motion.duration) next.set(id, old);
        } else {
          const origin = this.position(old, now);
          const target = { ...old.target, place: "exit", x: exit, y: corridor };
          next.set(id, { target, motion: { points: [origin, { x: origin.x, y: corridor }, target], start: now, duration: 540 } });
        }
      }
    }

    // Keep at most six departure sprites during bursts. Occupancy comes from visible.
    const departures = [...next].filter(([, sprite]) => sprite.target.place === "exit");
    for (const [id] of departures.slice(0, Math.max(0, departures.length - 6))) next.delete(id);
    this.sprites = next;
    this.lastArrival = lastArrival;
  }
}

function drawHalt(canvas, model, animation, now, smooth) {
  const { ctx, width, height } = canvasContext(canvas);
  if (!width || !height) return 0;
  const left = 15, right = width - left, usable = right - left;
  const bayTop = height * .22, bayHeight = height * .27;
  const laneTop = height * .67, laneBottom = height * .90;
  const bayCount = model?.bays.length ?? 1;
  const visible = [];

  ctx.fillStyle = "#0d1623";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#263348";
  for (let x = 12; x < width; x += 22) {
    for (let y = 12; y < height; y += 22) ctx.fillRect(x, y, 1, 1);
  }
  rounded(ctx, left, bayTop + bayHeight - 5, usable, height * .15, 8, "#182739");
  rounded(ctx, left, laneTop, usable, laneBottom - laneTop, 7, "#172638", "#2b3e52");
  ctx.strokeStyle = "#52667b";
  ctx.setLineDash([7, 8]);
  ctx.beginPath(); ctx.moveTo(left + 8, laneBottom - 10); ctx.lineTo(right - 9, laneBottom - 10); ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = "600 11px system-ui";
  ctx.fillStyle = "#a7b8cb";
  ctx.textAlign = "left";
  ctx.fillText("BOARDING BAYS", left, bayTop - 11);
  ctx.fillText("FCFS QUEUE", left, laneTop - 10);
  ctx.textAlign = "right";
  ctx.fillText("FRONT", right, laneTop - 10);

  const gap = usable < 430 ? 5 : 11;
  const bayWidth = Math.min(162, (usable - (bayCount - 1) * gap) / bayCount);
  const blockStart = left + (usable - (bayWidth * bayCount + gap * (bayCount - 1))) / 2;
  for (let bay = 0; bay < bayCount; bay++) {
    const x = blockStart + bay * (bayWidth + gap);
    const bus = model?.bays[bay];
    rounded(ctx, x, bayTop, bayWidth, bayHeight, 8, bus ? "#1c3b3a" : "#172536", bus ? "#62e0c3" : "#586d83");
    ctx.fillStyle = bus ? "#a5f2e2" : "#b0c1d2";
    ctx.textAlign = "center";
    ctx.font = "600 11px system-ui";
    ctx.fillText(`BAY ${bay + 1}`, x + bayWidth / 2, bayTop + 16);
    if (bus) {
      const busWidth = Math.min(64, bayWidth - 12);
      visible.push({ id: bus.id, place: "bay", x: x + (bayWidth - busWidth) / 2,
        y: bayTop + bayHeight / 2 - 4, width: busWidth, color: "#62e0c3" });
      const progress = Math.max(0, Math.min(1, (model.time - bus.arrival - bus.wait) / bus.service));
      const inset = 10, scale = bayWidth - inset * 2, barY = bayTop + bayHeight - 9;
      rounded(ctx, x + inset, barY, scale, 4, 2, "#305b57");
      if (progress > 0) rounded(ctx, x + inset, barY, scale * progress, 4, 2, "#62e0c3");
    } else {
      ctx.font = "11px system-ui";
      ctx.fillText("Available", x + bayWidth / 2, bayTop + bayHeight * .68);
    }
  }

  const busWidth = usable > 500 ? 58 : 45;
  const capacity = Math.max(1, Math.min(7, Math.floor((usable - 12) / (busWidth + 10))));
  const queueY = laneTop + 8;
  const queueX = (index) => right - busWidth - 10 - index * (busWidth + 10);
  let shown = 0;
  if (model) {
    for (const bus of model.queue.values()) {
      if (shown >= capacity) break;
      visible.push({ id: bus.id, place: "queue", x: queueX(shown++), y: queueY, width: busWidth, color: "#ffc16d" });
    }
  }
  if (!shown) {
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillStyle = "#a7b8cb";
    ctx.fillText("No buses waiting", width / 2, laneTop + 24);
  }

  animation.update(visible, {
    size: `${width}×${height}`, lastArrival: model?.lastArrival ?? 0, now, smooth,
    corridor: (bayTop + bayHeight + laneTop) / 2 - 12,
    tail: { x: queueX(capacity), y: queueY }, exit: width + 1,
  });
  for (const sprite of animation.sprites.values()) {
    const { x, y, id, width: busWidth, color } = animation.position(sprite, now);
    drawBus(ctx, x, y, busWidth, id, color, 22);
  }

  ctx.font = "11px system-ui";
  ctx.fillStyle = "#a7b8cb";
  ctx.textAlign = "left";
  ctx.fillText(model?.lastArrival ? `LATEST ARRIVAL #${model.lastArrival}` : "LATEST ARRIVAL", left, height - 9);
  ctx.textAlign = "right";
  ctx.fillText(model?.lastDeparture ? `LATEST DEPARTURE #${model.lastDeparture}` : "LATEST DEPARTURE", right, height - 9);
  return Math.max(0, (model?.queue.size ?? 0) - shown);
}

function drawChart(canvas, samples, key, color) {
  const { ctx, width, height } = canvasContext(canvas);
  if (!width || !height) return;
  const left = 45, right = width - 18, top = 13, bottom = height - 28;
  const points = samples.filter((sample) => sample[key] !== null);
  const start = samples[0]?.time ?? 0;
  const end = Math.max(start + 120, samples.at(-1)?.time ?? 0);
  const peak = points.reduce((max, point) => Math.max(max, point[key]), 0);
  const ceiling = key === "queued" ? Math.max(4, Math.ceil(peak / 4) * 4) : Math.max(4, peak * 1.1);
  const x = (time) => left + (time - start) / (end - start) * (right - left);
  const y = (value) => bottom - value / ceiling * (bottom - top);
  ctx.font = "11px system-ui";
  ctx.fillStyle = "#a7b8cb";
  ctx.strokeStyle = "#2a394b";
  ctx.textAlign = "right";
  for (let tick = 0; tick <= 4; tick++) {
    const value = tick * ceiling / 4;
    ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
    ctx.fillText(Number(value.toPrecision(3)).toString(), left - 7, y(value) + 4);
  }
  ctx.textAlign = "left";
  ctx.fillText(`${Number((start / HOUR).toFixed(2))} h`, left, bottom + 19);
  ctx.textAlign = "right";
  ctx.fillText(`${Number((end / HOUR).toFixed(2))} h`, right, bottom + 19);
  if (!points.length) {
    ctx.textAlign = "center";
    ctx.fillText("Waiting for a completed service", (left + right) / 2, height / 2);
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [index, point] of points.entries()) {
    if (index === 0) ctx.moveTo(x(point.time), y(point[key]));
    else {
      if (key === "queued") ctx.lineTo(x(point.time), y(points[index - 1][key]));
      ctx.lineTo(x(point.time), y(point[key]));
    }
  }
  ctx.stroke();
  const last = points.at(-1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x(last.time), y(last[key]), 3, 0, 2 * Math.PI);
  ctx.fill();
}

if (typeof document !== "undefined") startDashboard();
