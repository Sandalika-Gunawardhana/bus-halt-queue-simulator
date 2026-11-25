# Theory and mathematics

## System and empirical calibration

The model starts when a bus reaches the queue and ends when it leaves a boarding bay. Each bay serves one bus at a time. The bays are identical, service is non-preemptive, and a single unlimited queue serves buses first-come, first-served (FCFS). Buses never abandon the queue. Arrivals and service durations are independent, with constant parameters within each scenario. Passenger waiting, bay interference, downstream blocking and spillback are outside the system boundary.

Warapitiya, stop 109 in direction 1 on Kandy–Digana Route 654, supplies the reference inputs for a hypothetical urban halt. The notebook loads the verified version 2 data [1], checks data quality, parses date and time fields, accounts for midnight crossings, and rejects missing timestamps, negative times and recorded dwell times that differ from elapsed time by more than one second. It selects eligible non-terminal stops, separates directions and filters weekdays from 07:00 up to 09:00. Warapitiya ranked first by the count of positive-dwell observations within a stop–direction pair. Zero-duration records are included in quality diagnostics and excluded from positive-service calibration. See the [data provenance](data/README.md) and GPS processing study [4].

Let $N=842$ be the positive-dwell arrivals at the reference stop and direction, $D=193$ the route-active weekdays, and $H=2$ the hours in each daily observation window. Days with zero qualifying arrivals at the reference stop still count in $D$. Let $m$ be the arithmetic mean positive dwell duration in seconds, and $d$ the dimensionless hypothetical demand multiplier. Then

$$
\lambda_0=\frac{N}{DH}=2.1813471502590676\ \text{buses/hour},\qquad
\lambda=d\lambda_0,\qquad
m=55.98693586698338\ \text{seconds},\qquad
\mu=\frac{3600}{m}=64.30071487664665\ \text{buses/hour/bay}.
$$

The notebook uses a Student’s $t$ interval over daily rates and a day-cluster bootstrap with 5,000 draws for mean dwell. The primary experiments use the untrimmed positive-dwell mean. A separate diagnostic examines excluding observations above the 99th percentile. [Daily arrival-rate figure](figures/03_daily_arrival_rates.png) · [Dwell-time distribution](figures/01_raw_dwell_distribution.png)

## Arrival and service distributions

A homogeneous Poisson arrival process with rate $\lambda$ gives independent exponential interarrival intervals with mean $3600/\lambda$ seconds. Exponential service durations have mean $m$ seconds. For either exponential draw with mean $b$ seconds, the browser uses $-b\ln(1-U)$, where $U$ is uniform on $(0,1)$.

For the mean-matched lognormal alternative, write $S=m\exp(\sigma Z-\sigma^2/2)$, where $S$ is service duration in seconds, $Z$ is standard normal, and the dimensionless log-scale shape $\sigma=0.7759553844290873$. Then $\mathbb E[S]=m$ and $\mathbb E[S^2]=m^2\exp(\sigma^2)$. The browser generates $Z$ with Box–Muller. Python uses NumPy’s exponential and lognormal generators. See Law [5] for input modelling and random variates.

The daily count dispersion index (sample variance divided by mean) was 1.1468. The coefficients of variation for positive within-day arrival gaps and positive dwell were 0.7200 and 0.8838. An exponential model has a coefficient of variation of one. Among zero-location exponential, gamma and lognormal dwell fits, lognormal had the lowest AIC and BIC, and gamma had the lowest descriptive Kolmogorov–Smirnov statistic. These are fit comparisons on the same observations used to estimate the parameters. The lognormal sensitivity experiment uses the fitted shape with a rescaled mean. [Fitted service distributions](figures/02_service_distribution_fits.png)

## Queueing equations

Use hours for the analytical equations in this section and seconds for event times in code. Let $c$ be the number of bays (1, 2 or 3), $a=\lambda/\mu$ the offered traffic in erlangs, and $\rho=a/c$ the offered load per bay. For a stable queue, $\rho$ is the long-run average busy fraction per bay. A finite steady-state prediction requires $\rho<1$. At or above one, offered load meets or exceeds capacity. Offered load can exceed 100%, while actual occupancy is bounded by 100%.

For M/M/1 with $\lambda<\mu$, the waiting probability is $P_{\mathrm{wait}}=\rho$, the mean time in queue is $W_q=\lambda/[\mu(\mu-\lambda)]$, and mean time in system is $W=1/(\mu-\lambda)$, both in hours. For M/M/c, the probability $P_0$ that the system is empty, Erlang C waiting probability $P_{\mathrm{wait}}$, and mean times are [2]

$$
P_0=\left[\sum_{j=0}^{c-1}\frac{a^j}{j!}+\frac{a^c}{c!(1-\rho)}\right]^{-1},
\qquad
P_{\mathrm{wait}}=\frac{a^cP_0}{c!(1-\rho)},
\qquad
W_q=\frac{P_{\mathrm{wait}}}{c\mu-\lambda},
\qquad W=W_q+\frac1\mu .
$$

Here $j$ is the number of buses in the system in the finite sum. Little’s Law gives the steady-state mean queue and system sizes, $L_q=\lambda W_q$ and $L=\lambda W$, in buses. Multiply analytical hours by 3,600 to report seconds. [Analytical mean waits by arrival rate](figures/04_analytical_waiting_times.png)

For stable M/G/1, use $\lambda_s=\lambda/3600$ buses per second and service duration $S$ in seconds. The Pollaczek–Khinchine formula gives $W_q=\lambda_s\mathbb E[S^2]/[2(1-\rho)]$ in seconds, with $\rho=\lambda_s m$ [2]. The notebook checks the lognormal single-bay implementation against this formula. The multi-bay lognormal results are obtained by simulation.

## Discrete-event implementations

The SimPy reference uses a resource of capacity $c$ and bus processes that request a bay, wait in arrival order, hold it for a sampled duration and release it [3]. The simulation clock jumps between events. For each interval between changes, the queue length and occupied bay count are multiplied by the interval length. Over the observation window, dividing these integrals by observed time, or by $c$ times observed time for occupancy, gives mean queue length and utilisation. Waiting is service start minus arrival. System time is departure minus arrival.

The optimised notebook schedules arrivals in order using a min-heap of bay availability times. With arrival $A_i$, service duration $S_i$ and earliest available time $B_i$ for bus $i$ (all in seconds), service starts at $T_i=\max(A_i,B_i)$ and departure is $T_i+S_i$. The departure replaces the selected bay’s availability. For the same arrivals and service times, each next bus in the SimPy queue starts at that same time. The ordered queue and occupancy changes then reconstruct the same time-weighted metrics. The code falls back to SimPy for exact event ties that require its tie-breaking rules. NumPy array operations replace per-bus objects and DataFrames in replication sweeps.

The notebook uses separate NumPy arrival and service streams spawned from each replication seed. The baseline repeatability check uses seed 42, and the replication seed list is generated from master seed 2026. The same replication IDs and seeds are reused for paired comparisons. JavaScript uses separate seeded streams with its own generator and a chronological arrival/departure scheduler. Canvas motion is visual interpolation and does not delay model events.

## Experimental design and uncertainty

The main experiment uses multipliers 1×, 4×, 10×, 20×, 28× and 35× and one to three bays. Thirty independent replications within each of 17 stable exponential scenarios give 510 runs. The lognormal study uses the stable configurations at 10×, 20×, 28× and 35×, totalling 330 runs. Each steady-state run simulates 1,000 hours including 100 hours of warm-up. Buses arriving in the measurement window can finish after cutoff, while time-weighted statistics stop at the cutoff. The 35× one-bay case uses thirty runs at each of five finite horizons (2, 4, 8, 12 and 24 hours) from an empty system.

The warm-up test compares 0, 50, 100 and 200 hours at 28× with one bay, using ten runs per choice and a fixed 1,000-hour measurement window. The estimated waits range from about 1,009 to 1,040 seconds, with overlapping intervals. The sweep uses 100 hours to reduce initial-empty bias. Overlap leaves residual bias possible. [Warm-up sensitivity](figures/06_warmup_sensitivity.png) · [Unstable queue growth](figures/08_unstable_queue_growth.png)

For $r$ independent replication summaries $X_1,\ldots,X_r$ in the units of the metric, let $\bar X$ be their arithmetic mean and $s_X$ their sample standard deviation. The 95% interval is $\bar X\pm t_{0.975,r-1}s_X/\sqrt r$, where $t_{0.975,r-1}$ is the Student’s $t$ quantile with $r-1$ degrees of freedom. The service-distribution comparison applies this interval to within-seed differences. These intervals measure Monte Carlo sampling uncertainty for fixed model inputs [5].

## Verification

The notebook includes five analytical checks covering M/M/1, zero arrivals, the critical and overload cases, and the effect of added capacity. Ten event checks include non-negative waits, correct ordering, single-bay capacity and repeatability. Four representative checks compare the optimised metrics with SimPy.

The Erlang C mean fell inside **14 of 17** individual M/M/c intervals. At baseline with three bays, the model predicts about 0.37 waiting events across the 58,823 measured arrivals. The runs observed zero, producing an interval of zero width that missed the small positive analytical wait. The two remaining misses were at 35× with two and three bays, with absolute errors of about 0.317 s and 0.045 s. These intervals describe individual scenarios. All three single-bay lognormal means from Pollaczek–Khinchine fell within their corresponding simulation intervals. [Analytical versus simulated waits at 28×](figures/05_initial_simulation_comparison.png)

The browser’s dedicated verification uses 10× demand, one bay and exponential service. The analytical comparison uses a $10^{-8}$ s tolerance. The stochastic check reproduces the 30-run design, including warm-up and draining the cutoff cohort, with a different random generator. Its preset tolerance is three combined standard errors, estimated from the notebook’s 95% interval under comparable replication variance.

| Check | Browser (s) | Notebook (s) | Absolute error (s) | Tolerance (s) |
|---|---:|---:|---:|---:|
| Analytical mean wait | 28.744379 | 28.744379 | 0 | 0.00000001 |
| Mean of 30 replications | 28.652794 | 28.525311 | 0.127483 | 0.849757 |

Both browser comparisons pass. The browser also tests FCFS, non-negative waits, conservation, utilisation, seed reproducibility and speed independence. An analytical result is a steady-state model prediction. An experimental mean aggregates replications. An interactive run is one seeded trajectory from an empty halt.

## Performance engineering

The controlled local benchmark ran the reference and optimised notebook on the same Apple Silicon Mac under comparable local conditions. Both timings include a fresh dataset download and exclude dependency installation.

| Local section | SimPy reference (s) | Optimised (s) |
|---|---:|---:|
| Warm-up sensitivity | 14.49 | 0.53 |
| Exponential replications | 89.00 | 3.30 |
| Lognormal replications | 86.82 | 3.11 |
| Unstable scenarios | 0.66 | 0.04 |
| Full notebook | **197.41** | **12.42** |

The full run was about **15.9× faster**, a **93.7%** runtime reduction. SimPy event processing dominated the profile. A 30-replication trial of the optimised code took 0.36 s serially and 0.42 s with two spawned workers including startup, so the notebook retains serial execution. In 108 local equivalence scenarios, per-bus event times, service draws and summary metrics matched the reference. The fresh comparison produced byte-identical versions of all eight experimental CSVs and nine figures. The optimised exports also matched the original saved CSVs within an absolute tolerance of $10^{-8}$.

Fresh Colab CPU runs were observed at approximately 17 minutes before optimisation and approximately one minute after it. Those observations are separate from the controlled local comparison. Colab resource allocation, dependency installation and download times can vary.

## Interpretation and limitations

The [capacity experiment](figures/07_demand_capacity_experiment.png) shows the nonlinear growth in mean waits near saturation and the reduction from adding bays under hypothetical high demand. The [distribution comparison](figures/09_distribution_comparison.png) shows sensitivity to service-time variability while holding the arithmetic mean fixed.

Warapitiya GPS dwell is a proxy for service time. It does not measure queue entry, queue delay or bay occupancy directly. The calibrated hypothetical scenarios support analytical verification, and operational validation would require independently observed data at the intended site [6]. A next study could collect time-varying arrivals and service times, distinguish boarding from other dwell activities, and model correlated demand, constrained queue space or interference between bays.

Numbered sources are listed in [References](REFERENCES.md).
