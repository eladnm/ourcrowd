/**
 * Thrown when the failure has already been explained to the user.
 *
 * Entry points check for this so a carefully written message (Ollama install
 * guidance, for instance) is not followed by a second, less useful line.
 */
export class AlreadyReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyReportedError';
  }
}
