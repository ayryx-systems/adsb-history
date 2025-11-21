/**
 * Quantile Regression
 * 
 * Predicts specific quantiles (percentiles) of the target distribution
 * instead of just the mean. This captures the full distribution shape,
 * including tail risk.
 * 
 * Uses quantile loss (pinball loss) function:
 *   L_τ(y, ŷ) = max(τ(y - ŷ), (1-τ)(ŷ - y))
 * 
 * where τ is the quantile level (0-1)
 */

class QuantileRegression {
  constructor(quantile) {
    if (quantile <= 0 || quantile >= 1) {
      throw new Error('Quantile must be between 0 and 1');
    }
    this.quantile = quantile;
    this.coefficients = null;
    this.intercept = null;
    this.featureNames = null;
  }

  /**
   * Train the quantile regression model
   * @param {Array<Array<number>>} X - Feature matrix
   * @param {Array<number>} y - Target vector
   * @param {Array<string>} featureNames - Feature names (optional)
   */
  fit(X, y, featureNames = null) {
    if (X.length !== y.length) {
      throw new Error('X and y must have the same length');
    }

    if (X.length === 0) {
      throw new Error('Training data cannot be empty');
    }

    this.featureNames = featureNames || X[0].map((_, i) => `feature_${i}`);
    const nFeatures = X[0].length;

    const XWithIntercept = X.map((row) => [1, ...row]);
    const coefficients = this.solveQuantileRegression(XWithIntercept, y, this.quantile);

    this.intercept = coefficients[0];
    this.coefficients = coefficients.slice(1);

    return this;
  }

  /**
   * Make predictions
   * @param {Array<Array<number>>} X - Feature matrix
   * @returns {Array<number>} Predictions
   */
  predict(X) {
    if (!this.coefficients || this.intercept === null) {
      throw new Error('Model must be trained before making predictions');
    }

    return X.map((row) => {
      if (row.length !== this.coefficients.length) {
        throw new Error('Feature count mismatch in prediction');
      }

      let prediction = this.intercept;
      for (let i = 0; i < row.length; i++) {
        prediction += this.coefficients[i] * row[i];
      }
      return prediction;
    });
  }

  /**
   * Solve quantile regression using linear programming or iterative method
   * For simplicity, using iterative coordinate descent with quantile loss
   */
  solveQuantileRegression(X, y, quantile, maxIterations = 100, tolerance = 1e-6) {
    const nSamples = X.length;
    const nFeatures = X[0].length;

    let coefficients = Array(nFeatures).fill(0);
    let previousLoss = Infinity;

    for (let iter = 0; iter < maxIterations; iter++) {
      for (let j = 0; j < nFeatures; j++) {
        const gradient = this.calculateGradient(X, y, coefficients, quantile, j);
        const stepSize = this.calculateStepSize(X, y, coefficients, quantile, j, gradient);
        coefficients[j] -= stepSize * gradient;
      }

      const loss = this.calculateQuantileLoss(X, y, coefficients, quantile);
      if (Math.abs(previousLoss - loss) < tolerance) {
        break;
      }
      previousLoss = loss;
    }

    return coefficients;
  }

  /**
   * Calculate gradient of quantile loss with respect to coefficient j
   */
  calculateGradient(X, y, coefficients, quantile, featureIndex) {
    let gradient = 0;

    for (let i = 0; i < X.length; i++) {
      const prediction = this.dotProduct(X[i], coefficients);
      const residual = y[i] - prediction;
      const xij = X[i][featureIndex];

      if (residual > 0) {
        gradient += -quantile * xij;
      } else if (residual < 0) {
        gradient += (1 - quantile) * xij;
      }
    }

    return gradient / X.length;
  }

  /**
   * Calculate step size for coordinate descent
   */
  calculateStepSize(X, y, coefficients, quantile, featureIndex, gradient) {
    const learningRate = 0.01;
    return learningRate;
  }

  /**
   * Calculate quantile loss (pinball loss)
   */
  calculateQuantileLoss(X, y, coefficients, quantile) {
    let loss = 0;

    for (let i = 0; i < X.length; i++) {
      const prediction = this.dotProduct(X[i], coefficients);
      const residual = y[i] - prediction;

      if (residual > 0) {
        loss += quantile * residual;
      } else {
        loss += (quantile - 1) * residual;
      }
    }

    return loss / X.length;
  }

  /**
   * Dot product helper
   */
  dotProduct(a, b) {
    return a.reduce((sum, val, i) => sum + val * b[i], 0);
  }

  /**
   * Get model summary
   */
  getSummary() {
    const coefficients = {};
    for (let i = 0; i < this.featureNames.length; i++) {
      coefficients[this.featureNames[i]] = this.coefficients[i];
    }

    return {
      quantile: this.quantile,
      intercept: this.intercept,
      coefficients,
      featureNames: this.featureNames,
    };
  }
}

export default QuantileRegression;


