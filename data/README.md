# Data provenance

The notebook uses version 2 (26 April 2023) of Shiveswarran R's *Bus travel time data*, derived from GPS observations on Sri Lanka's Route 654. Kaggle identifies the data files as copyrighted by the original authors. The source CSVs are obtained from the publisher and kept out of this repository. [Dataset listing](https://www.kaggle.com/datasets/shiveswarranr/bus-travel-time-data) · [Publisher metadata](https://www.kaggle.com/api/v1/datasets/view/shiveswarranr/bus-travel-time-data)

| Source file | Use in the notebook |
|---|---|
| `bus_dwell_times_654.csv` | Calibration and analysis of arrivals and dwell times |
| `bus_stops_and_terminals_654.csv` | Stop metadata and reference stop selection |
| `bus_trips_654.csv` | Exploratory inspection of trip metadata |

The publisher's archive also contains a running-time CSV, which the notebook does not read. The notebook downloads version 2 through [KaggleHub](https://github.com/Kaggle/kagglehub) using the handle `shiveswarranr/bus-travel-time-data/versions/2`. KaggleHub extracts the files into its runtime cache. The notebook checks the SHA-256 of all three inputs before pandas parses any of them.
