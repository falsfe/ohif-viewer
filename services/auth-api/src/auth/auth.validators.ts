import type { LoginInput, RegisterInput } from './auth.types';
import { HttpError } from '../utils/http-error';

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function requireNonEmptyString(rawValue: unknown, fieldName: string): string {
  if (typeof rawValue !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', `${fieldName} must be a string.`, {
      field: fieldName,
    });
  }

  const value = rawValue.trim();

  if (!value) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${fieldName} is required.`, {
      field: fieldName,
    });
  }

  return value;
}

function validatePassword(password: string, fieldName: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      `${fieldName} must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
      {
        field: fieldName,
      }
    );
  }
}

export function validateRegisterInput(input: unknown): RegisterInput {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
  }

  const record = input as Record<string, unknown>;
  const username = requireNonEmptyString(record.username, 'username');
  const email = requireNonEmptyString(record.email, 'email').toLowerCase();
  const password = requireNonEmptyString(record.password, 'password');
  const confirmPassword = requireNonEmptyString(record.confirmPassword, 'confirmPassword');

  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'username must be 3-64 characters and only contain letters, numbers, underscore, dash, or dot.',
      { field: 'username' }
    );
  }

  if (!EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'email must be a valid email address.', {
      field: 'email',
    });
  }

  validatePassword(password, 'password');

  if (password !== confirmPassword) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'confirmPassword must match password.', {
      field: 'confirmPassword',
    });
  }

  return {
    username,
    email,
    password,
    confirmPassword,
  };
}

export function validateLoginInput(input: unknown): LoginInput {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
  }

  const record = input as Record<string, unknown>;
  const usernameOrEmail = requireNonEmptyString(record.usernameOrEmail, 'usernameOrEmail');
  const password = requireNonEmptyString(record.password, 'password');

  validatePassword(password, 'password');

  return {
    usernameOrEmail,
    password,
  };
}
