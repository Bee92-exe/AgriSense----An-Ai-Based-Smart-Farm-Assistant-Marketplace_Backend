/** An error that is safe to expose to the client with the given status code. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly messageBn?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
