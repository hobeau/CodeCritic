/**
 * PhaseResult - Status object returned by agent phases
 * Encapsulates the result of a phase execution with status and optional data
 */

class PhaseResult {
  /**
   * @param {string} status - Status code: 'continue', 'stop', 'final', 'retry', 'failure'
   * @param {*} data - Optional data payload
   * @param {string} message - Optional status message
   */
  constructor(status, data = null, message = null) {
    this.status = status;
    this.data = data;
    this.message = message;
  }

  /**
   * Create a 'continue' result - phase completed successfully, proceed to next
   * @param {*} data - Optional data to pass to next phase
   * @returns {PhaseResult}
   */
  static continue(data = null) {
    return new PhaseResult('continue', data);
  }

  /**
   * Create a 'stop' result - user requested stop, terminate execution
   * @param {string} message - Optional stop message
   * @returns {PhaseResult}
   */
  static stop(message = 'Stopped.') {
    return new PhaseResult('stop', null, message);
  }

  /**
   * Create a 'final' result - agent completed task, return final response
   * @param {string} response - Final response text
   * @param {*} data - Optional additional data (plan, evidence, etc.)
   * @returns {PhaseResult}
   */
  static final(response, data = null) {
    return new PhaseResult('final', data, response);
  }

  /**
   * Create a 'retry' result - operation failed, retry current phase
   * @param {string} reason - Reason for retry
   * @returns {PhaseResult}
   */
  static retry(reason = 'Retrying') {
    return new PhaseResult('retry', null, reason);
  }

  /**
   * Create a 'failure' result - unrecoverable failure, terminate execution
   * @param {string} reason - Failure reason
   * @returns {PhaseResult}
   */
  static failure(reason) {
    return new PhaseResult('failure', null, reason);
  }

  /**
   * Check if this is a 'continue' result
   * @returns {boolean}
   */
  isContinue() {
    return this.status === 'continue';
  }

  /**
   * Check if this is a 'stop' result
   * @returns {boolean}
   */
  isStop() {
    return this.status === 'stop';
  }

  /**
   * Check if this is a 'final' result
   * @returns {boolean}
   */
  isFinal() {
    return this.status === 'final';
  }

  /**
   * Check if this is a 'retry' result
   * @returns {boolean}
   */
  isRetry() {
    return this.status === 'retry';
  }

  /**
   * Check if this is a 'failure' result
   * @returns {boolean}
   */
  isFailure() {
    return this.status === 'failure';
  }
}

module.exports = { PhaseResult };
