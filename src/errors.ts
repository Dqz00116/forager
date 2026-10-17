export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly isOperational = true) {
    super(message);
    this.name = new.target.name;
  }
}
export class ConfigError extends AppError { constructor(m: string){ super(m, "CONFIG_ERROR"); } }
export class FetchError extends AppError { constructor(m: string, public readonly status?: number){ super(m, "FETCH_ERROR"); } }
export class RenderError extends AppError { constructor(m: string){ super(m, "RENDER_ERROR"); } }
export class ModelError extends AppError { constructor(m: string){ super(m, "MODEL_ERROR"); } }
