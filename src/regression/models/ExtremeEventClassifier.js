/**
 * Extreme Event Classifier
 * 
 * Predicts the probability of extreme events that cause long delays:
 * - Go-arounds / Missed approaches
 * - Diversions
 * - Extended holding patterns
 * - Multiple approach attempts
 * 
 * Uses logistic regression for interpretable probabilities
 */

class ExtremeEventClassifier {
  constructor(eventType = 'go_around') {
    this.eventType = eventType;
    this.coefficients = null;
    this.intercept = null;
    this.featureNames = null;
  }

  /**
   * Train the classifier
   * @param {Array<Array<number>>} X - Feature matrix
   * @param {Array<number>} y - Binary labels (0 or 1)
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
    const coefficients = this.solveLogisticRegression(XWithIntercept, y);

    this.intercept = coefficients[0];
    this.coefficients = coefficients.slice(1);

    return this;
  }

  /**
   * Predict probabilities
   * @param {Array<Array<number>>} X - Feature matrix
   * @returns {Array<number>} Probabilities (0-1)
   */
  predictProba(X) {
    if (!this.coefficients || this.intercept === null) {
      throw new Error('Model must be trained before making predictions');
    }

    return X.map((row) => {
      if (row.length !== this.coefficients.length) {
        throw new Error('Feature count mismatch in prediction');
      }

      let logit = this.intercept;
      for (let i = 0; i < row.length; i++) {
        logit += this.coefficients[i] * row[i];
      }

      return this.sigmoid(logit);
    });
  }

  /**
   * Predict binary labels
   * @param {Array<Array<number>>} X - Feature matrix
   * @param {number} threshold - Classification threshold (default 0.5)
   * @returns {Array<number>} Binary predictions (0 or 1)
   */
  predict(X, threshold = 0.5) {
    const probabilities = this.predictProba(X);
    return probabilities.map((p) => (p >= threshold ? 1 : 0));
  }

  /**
   * Solve logistic regression using gradient descent
   */
  solveLogisticRegression(X, y, maxIterations = 1000, learningRate = 0.01, tolerance = 1e-6) {
    const nSamples = X.length;
    const nFeatures = X[0].length;

    let coefficients = Array(nFeatures).fill(0);
    let previousLoss = Infinity;

    for (let iter = 0; iter < maxIterations; iter++) {
      const predictions = X.map((row) => this.sigmoid(this.dotProduct(row, coefficients)));
      const gradients = this.calculateGradients(X, y, predictions);

      for (let j = 0; j < nFeatures; j++) {
        coefficients[j] -= learningRate * gradients[j];
      }

      const loss = this.calculateLogLoss(y, predictions);
      if (Math.abs(previousLoss - loss) < tolerance) {
        break;
      }
      previousLoss = loss;
    }

    return coefficients;
  }

  /**
   * Calculate gradients for logistic regression
   */
  calculateGradients(X, y, predictions) {
    const nSamples = X.length;
    const nFeatures = X[0].length;
    const gradients = Array(nFeatures).fill(0);

    for (let i = 0; i < nSamples; i++) {
      const error = predictions[i] - y[i];
      for (let j = 0; j < nFeatures; j++) {
        gradients[j] += error * X[i][j];
      }
    }

    return gradients.map((g) => g / nSamples);
  }

  /**
   * Calculate log loss
   */
  calculateLogLoss(y, predictions) {
    let loss = 0;
    for (let i = 0; i < y.length; i++) {
      const p = Math.max(1e-15, Math.min(1 - 1e-15, predictions[i]));
      loss -= y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p);
    }
    return loss / y.length;
  }

  /**
   * Sigmoid function
   */
  sigmoid(x) {
    return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
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
      eventType: this.eventType,
      intercept: this.intercept,
      coefficients,
      featureNames: this.featureNames,
    };
  }
}

export default ExtremeEventClassifier;

