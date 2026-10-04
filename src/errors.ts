export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = (name: string) =>
  new AppError(404, "NOT_FOUND", `${name} not found`);
export const conflict = (message: string) =>
  new AppError(409, "CONFLICT", message);
