// Shared error identity: adapters and application services must use this class.
export class ServiceError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
