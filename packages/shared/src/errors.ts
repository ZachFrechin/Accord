export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN');
  }
}

export class ValidationAppError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}
