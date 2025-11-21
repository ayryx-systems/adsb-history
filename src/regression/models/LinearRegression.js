/**
 * Simple linear regression implementation
 * 
 * Transparent, interpretable model for arrival time prediction
 * 
 * Model: y = β₀ + β₁x₁ + β₂x₂ + ... + βₙxₙ + ε
 * 
 * Features:
 * - Ordinary Least Squares (OLS) estimation
 * - Coefficient interpretation
 * - R² and RMSE metrics
 * - Feature importance calculation
 */

class LinearRegression {
  constructor() {
    this.coefficients = null;
    this.intercept = null;
    this.featureNames = null;
    this.rSquared = null;
    this.rmse = null;
    this.nSamples = null;
  }

  /**
   * Train the model
   * @param {Array<Array<number>>} X - Feature matrix (n_samples × n_features)
   * @param {Array<number>} y - Target vector (n_samples)
   * @param {Array<string>} featureNames - Names of features (optional)
   */
  fit(X, y, featureNames = null) {
    if (X.length !== y.length) {
      throw new Error('X and y must have the same length');
    }

    if (X.length === 0) {
      throw new Error('Training data cannot be empty');
    }

    this.nSamples = X.length;
    this.featureNames = featureNames || X[0].map((_, i) => `feature_${i}`);

    if (X[0].length !== this.featureNames.length) {
      throw new Error('Feature count mismatch');
    }

    const nFeatures = X[0].length;

    const XWithIntercept = X.map((row) => [1, ...row]);
    const XtX = this.matrixMultiply(this.transpose(XWithIntercept), XWithIntercept);
    const Xty = this.matrixVectorMultiply(this.transpose(XWithIntercept), y);

    try {
      const coefficients = this.solveLinearSystem(XtX, Xty);
      this.intercept = coefficients[0];
      this.coefficients = coefficients.slice(1);
    } catch (error) {
      throw new Error(`Failed to solve linear system: ${error.message}`);
    }

    const predictions = this.predict(X);
    this.rSquared = this.calculateRSquared(y, predictions);
    this.rmse = this.calculateRMSE(y, predictions);

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
   * Get feature importance (absolute coefficient values, normalized)
   * @returns {Object} Feature importance scores
   */
  getFeatureImportance() {
    if (!this.coefficients) {
      return {};
    }

    const absCoeffs = this.coefficients.map((c) => Math.abs(c));
    const sum = absCoeffs.reduce((a, b) => a + b, 0);

    const importance = {};
    for (let i = 0; i < this.featureNames.length; i++) {
      importance[this.featureNames[i]] = sum > 0 ? absCoeffs[i] / sum : 0;
    }

    return importance;
  }

  /**
   * Get model summary
   * @returns {Object} Model summary
   */
  getSummary() {
    const coefficients = {};
    for (let i = 0; i < this.featureNames.length; i++) {
      coefficients[this.featureNames[i]] = this.coefficients[i];
    }

    return {
      intercept: this.intercept,
      coefficients,
      rSquared: this.rSquared,
      rmse: this.rmse,
      nSamples: this.nSamples,
      nFeatures: this.coefficients.length,
      featureImportance: this.getFeatureImportance(),
    };
  }

  /**
   * Matrix multiplication: A × B
   */
  matrixMultiply(A, B) {
    const rows = A.length;
    const cols = B[0].length;
    const result = Array(rows)
      .fill(0)
      .map(() => Array(cols).fill(0));

    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        for (let k = 0; k < B.length; k++) {
          result[i][j] += A[i][k] * B[k][j];
        }
      }
    }

    return result;
  }

  /**
   * Matrix-vector multiplication: A × v
   */
  matrixVectorMultiply(A, v) {
    return A.map((row) => {
      return row.reduce((sum, val, i) => sum + val * v[i], 0);
    });
  }

  /**
   * Transpose matrix
   */
  transpose(A) {
    return A[0].map((_, colIndex) => A.map((row) => row[colIndex]));
  }

  /**
   * Solve linear system Ax = b using Gaussian elimination
   */
  solveLinearSystem(A, b) {
    const n = A.length;
    const augmented = A.map((row, i) => [...row, b[i]]);

    for (let i = 0; i < n; i++) {
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
          maxRow = k;
        }
      }

      [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

      if (Math.abs(augmented[i][i]) < 1e-10) {
        throw new Error('Matrix is singular or nearly singular');
      }

      for (let k = i + 1; k < n; k++) {
        const factor = augmented[k][i] / augmented[i][i];
        for (let j = i; j < n + 1; j++) {
          augmented[k][j] -= factor * augmented[i][j];
        }
      }
    }

    const x = Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      x[i] = augmented[i][n];
      for (let j = i + 1; j < n; j++) {
        x[i] -= augmented[i][j] * x[j];
      }
      x[i] /= augmented[i][i];
    }

    return x;
  }

  /**
   * Calculate R² (coefficient of determination)
   */
  calculateRSquared(yTrue, yPred) {
    const yMean = yTrue.reduce((a, b) => a + b, 0) / yTrue.length;
    const ssRes = yTrue.reduce((sum, y, i) => sum + Math.pow(y - yPred[i], 2), 0);
    const ssTot = yTrue.reduce((sum, y) => sum + Math.pow(y - yMean, 2), 0);

    return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  }

  /**
   * Calculate RMSE (Root Mean Squared Error)
   */
  calculateRMSE(yTrue, yPred) {
    const mse = yTrue.reduce((sum, y, i) => sum + Math.pow(y - yPred[i], 2), 0) / yTrue.length;
    return Math.sqrt(mse);
  }
}

export default LinearRegression;

