# Arrival Time Prediction Regression

Transparent, extensible regression models for predicting aircraft arrival times based on weather and other factors.

## Overview

This module provides:
- **Feature Engineering**: Extract weather and temporal features from METAR and flight data
- **Data Joining**: Match flight arrivals to weather observations
- **Linear Regression**: Transparent, interpretable model with coefficient explanations
- **Extensibility**: Easy to add new features (holidays, time of day, etc.)

## Quick Start

### 1. Train a Model

```bash
node scripts/regression/train-model.js \
  --airport KORD \
  --start-date 2024-01-01 \
  --end-date 2024-12-31 \
  --runway-heading 270
```

This will:
- Load flight summaries and METAR data for the specified airport and date range
- Join flights to weather observations (within ±30 minutes of touchdown)
- Extract features (visibility, ceiling, wind, temporal, etc.)
- Train a linear regression model
- Save the model to `cache/models/KORD_model.json`

### 2. Model Output

The trained model includes:
- **Coefficients**: Impact of each feature (in seconds)
- **R²**: Model fit quality (0-1, higher is better)
- **RMSE**: Prediction error (in seconds)
- **Feature Importance**: Relative importance of each feature

Example output:
```json
{
  "airport": "KORD",
  "trainingPeriod": { "start": "2024-01-01", "end": "2024-12-31" },
  "nSamples": 12345,
  "rSquared": 0.42,
  "rmse": 180.5,
  "coefficients": {
    "intercept": 1200.0,
    "visibility_sm": -15.2,
    "wind_speed_kt": 2.3,
    "precipitation": 45.0
  }
}
```

## Architecture

### Feature Engineering

**Weather Features** (`WeatherFeatureExtractor.js`):
- Visibility (statute miles)
- Ceiling (feet AGL)
- Wind speed, direction, gusts
- Crosswind/headwind components (requires runway heading)
- Temperature, dewpoint
- Precipitation indicators
- Flight category (VFR/MVFR/IFR/LIFR)

**Temporal Features** (`TemporalFeatureExtractor.js`):
- Hour of day (0-23)
- Day of week (0-6)
- Month (1-12)
- Weekend indicator
- Holiday indicator (US holidays included, extensible)

### Data Joining

**FlightWeatherJoiner** matches each flight's touchdown time to the nearest METAR observation:
- Time window: ±30 minutes (configurable)
- Uses closest METAR in time
- Skips flights without matching weather data

### Model

**LinearRegression** implements Ordinary Least Squares (OLS):
- Transparent coefficients (seconds per unit)
- Feature importance scores
- R² and RMSE metrics
- Simple to interpret and explain

## Extending the Model

### Adding New Features

1. **Add to Feature Extractor**:
   - Extend `WeatherFeatureExtractor` or `TemporalFeatureExtractor`
   - Add feature extraction logic

2. **Update Feature Preparation**:
   - Modify `prepareFeatures()` in `train-model.js`
   - Add new features to feature vector

3. **Retrain Model**:
   - Run training script with new features
   - Compare R² and RMSE improvements

### Adding Holidays

The `TemporalFeatureExtractor` includes a default US holiday calendar. To add custom holidays:

```javascript
const temporalExtractor = new TemporalFeatureExtractor();
temporalExtractor.addHolidays({
  '2024-12-31': 'New Years Eve',
  '2024-07-03': 'Independence Day Eve',
});
```

### Adding Airport-Specific Features

You can extend the model with airport-specific features:
- Runway configuration
- Traffic volume
- Time-of-day patterns
- Seasonal variations

## Model Interpretation

### Coefficients

Each coefficient shows the impact of a feature on arrival time:
- **Positive coefficient**: Increases arrival time (slower)
- **Negative coefficient**: Decreases arrival time (faster)
- **Magnitude**: Seconds per unit change

Example:
- `visibility_sm: -15.2` means each mile of visibility reduces arrival time by 15.2 seconds
- `precipitation: 45.0` means precipitation adds 45 seconds to arrival time

### Feature Importance

Feature importance is calculated as normalized absolute coefficients:
- Shows which features have the most impact
- Sums to 1.0 (100%)
- Useful for understanding model behavior

### Prediction Formula

```
arrival_time = intercept 
             + (visibility × visibility_coeff)
             + (ceiling × ceiling_coeff)
             + (wind_speed × wind_coeff)
             + ... 
             + (is_holiday × holiday_coeff)
```

## Next Steps

1. **Evaluate Model Quality**:
   - Check R² (target: >0.3 for weather-only model)
   - Check RMSE (target: <3 minutes for 100nm segment)
   - Analyze residuals for patterns

2. **Add More Features**:
   - Aircraft type (stratified models)
   - Time-of-day interactions
   - Weather condition interactions
   - Historical traffic patterns

3. **Improve Model**:
   - Try polynomial features (non-linear relationships)
   - Try regularization (Ridge/Lasso) if overfitting
   - Try gradient boosting if linear model insufficient

4. **Deploy for Predictions**:
   - Create prediction script
   - Integrate with planning app
   - Add confidence intervals

## Files

- `feature_engineering/WeatherFeatureExtractor.js` - Extract weather features
- `feature_engineering/TemporalFeatureExtractor.js` - Extract temporal features
- `data_joining/FlightWeatherJoiner.js` - Join flights to weather
- `models/LinearRegression.js` - Linear regression implementation
- `scripts/regression/train-model.js` - Training script

