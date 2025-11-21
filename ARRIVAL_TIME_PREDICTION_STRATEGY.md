# Arrival Time Prediction Strategy

## Problem: Mean Predictions Miss Tail Risk

**Traditional approach**: Predict mean arrival time

- Example: "Stormy conditions → +10 minutes delay"
- **Problem**: Misses critical tail risk

**Reality in adverse weather**:

- Most flights: +5 minutes (90% of cases)
- Some flights: +60+ minutes (8% of cases - go-arounds, diversions, holding)
- **Critical information**: The 8% tail risk, not the +10 min average

## Solution: Full Distribution Modeling

Model the **entire distribution** of arrival times, not just the mean.

### Architecture: Three-Layer Approach

```
┌─────────────────────────────────────────────────────────────┐
│  DATA: Flight arrivals + Weather (METAR)                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ QUANTILE     │ │ EXTREME      │ │ DISTRIBUTION │
│ REGRESSION   │ │ EVENT        │ │ SHAPE        │
│              │ │ CLASSIFIER   │ │ ANALYZER     │
│ Q10-Q99      │ │ P(go-around) │ │ Skewness,    │
│ percentiles  │ │ P(diversion) │ │ Variance,    │
│              │ │ P(holding)   │ │ Tail index   │
└──────────────┘ └──────────────┘ └──────────────┘
        │              │              │
        └──────────────┼──────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  UNIFIED PREDICTION: Full distribution + Risk metrics        │
└─────────────────────────────────────────────────────────────┘
```

### Component 1: Quantile Regression

Predicts multiple percentiles of the arrival time distribution:

- **Q10** (10th percentile): "Best case" - 10% of flights are faster
- **Q50** (median): "Typical" - 50% of flights are faster/slower
- **Q90** (90th percentile): "Worst case (normal)"
- **Q95** (95th percentile): "Severe delay"
- **Q99** (99th percentile): "Extreme delay"

**Example output**:

```json
{
  "quantile_predictions": {
    "q10": 1200, // 20 min - 10% chance < 20 min
    "q50": 1500, // 25 min - 50% chance < 25 min (median)
    "q90": 2400, // 40 min - 90% chance < 40 min
    "q95": 3000, // 50 min - 95% chance < 50 min
    "q99": 4500 // 75 min - 99% chance < 75 min
  }
}
```

### Component 2: Extreme Event Classifier

Separately models probability of extreme events causing long delays:

- **Go-arounds/Missed approaches**: Aircraft aborts landing
- **Diversions**: Aircraft diverts to alternate airport
- **Extended holding**: Aircraft enters holding pattern >10 minutes

**Example output**:

```json
{
  "extreme_event_probabilities": {
    "go_around": 0.12, // 12% chance
    "diversion": 0.03, // 3% chance
    "extended_holding": 0.15, // 15% chance
    "any_extreme": 0.25 // 25% chance of any extreme event
  }
}
```

### Component 3: Distribution Shape Analysis

Identifies when conditions lead to long-tail distributions:

- **Skewness**: Right-skewed distribution (long tail)?
- **Variance**: How unpredictable are delays?
- **Tail index**: How heavy is the tail?

**Example output**:

```json
{
  "distribution_characteristics": {
    "mean": 1650, // 27.5 min
    "median": 1500, // 25 min
    "skewness": 2.3, // Long-tailed
    "is_long_tailed": true,
    "risk_indicators": {
      "high_variance": true,
      "high_skewness": true
    }
  }
}
```

## Unified Prediction Output

Combining all three layers provides actionable risk information:

```json
{
  "weather_conditions": {
    "visibility_sm": 1.5,
    "ceiling_ft": 800,
    "wind_speed_kt": 25,
    "precipitation": true
  },

  "quantile_predictions": {
    "q10": 1200,
    "q25": 1350,
    "q50": 1500,
    "q75": 1800,
    "q90": 2400,
    "q95": 3000,
    "q99": 4500
  },

  "extreme_event_risk": {
    "go_around_probability": 0.12,
    "diversion_probability": 0.03,
    "any_extreme_event": 0.25
  },

  "risk_metrics": {
    "p_delay_30min": 0.25, // 25% chance > 30 min
    "p_delay_60min": 0.08, // 8% chance > 60 min ← KEY INFO
    "expected_delay": 1650, // Mean: 27.5 min (reference)
    "tail_risk": 0.08 // 8% extreme delay risk
  },

  "interpretation": {
    "typical_delay": "25 minutes (median)",
    "severe_delay_risk": "8% chance of >60 minute delay",
    "extreme_event_risk": "25% chance of go-around/diversion/holding",
    "recommendation": "Plan for 30-40 min buffer, with contingency for 60+ min delays"
  }
}
```

## Implementation

### Data Requirements

- **Flight Data**: Arrival times (`timeFrom100nm` in seconds) from flight summaries
- **Weather Data**: METAR observations (visibility, ceiling, wind, precipitation)
- **Extreme Events**: Flags for go-arounds, diversions, holding patterns

### Feature Engineering

**Weather Features**:

- Visibility (statute miles)
- Ceiling (feet AGL)
- Wind speed, direction, gusts
- Crosswind/headwind components (requires runway heading)
- Precipitation indicators
- Flight category (VFR/MVFR/IFR/LIFR)

**Temporal Features**:

- Hour of day, day of week, month
- Weekend indicator
- Holiday indicator (extensible)

### Training

```bash
node scripts/regression/train-distribution-model.js \
  --airport KORD \
  --start-date 2024-01-01 \
  --end-date 2024-12-31 \
  --runway-heading 270
```

**Output**: `cache/models/KORD_distribution_model.json` containing:

- Quantile regression models (Q10-Q99)
- Extreme event classifiers
- Distribution analysis
- All coefficients and metrics

### Model Components

1. **QuantileRegression** (`src/regression/models/QuantileRegression.js`)

   - Uses quantile loss (pinball loss) function
   - Trains separate models for each quantile

2. **ExtremeEventClassifier** (`src/regression/models/ExtremeEventClassifier.js`)

   - Logistic regression for interpretable probabilities
   - Separate classifier for each event type

3. **DistributionAnalyzer** (`src/regression/analysis/DistributionAnalyzer.js`)
   - Calculates skewness, kurtosis, tail index
   - Identifies long-tail conditions

## Key Advantages

1. **Transparency**: Coefficients show impact on different parts of distribution
2. **Actionable**: Provides specific risk information ("8% chance >60 min")
3. **Captures Long Tail**: Models full distribution, not just mean
4. **Extensible**: Easy to add new quantiles, events, or features

## Next Steps

1. **Validate Extreme Event Detection**: Ensure accurate detection of go-arounds/diversions from ADSB data
2. **Test Training**: Run on historical data to see distribution characteristics
3. **Refine Quantiles**: Determine which percentiles are most useful
4. **Add Features**: Holidays, traffic volume, time-of-day interactions
5. **Integrate**: Use predictions in planning app for risk-aware decision making

## Questions to Explore

- **Extreme Event Detection**: How accurately can we detect these from ADSB alone?
- **Quantile Selection**: Which quantiles are most useful for decision-making?
- **Feature Engineering**: What features best predict extreme events?
- **Distribution Modeling**: Parametric (Gamma, Weibull) vs non-parametric (quantile regression)?
