/**
 * 结构化错误：所有面向调用方的拒绝都带稳定错误码，便于回执与测试断言。
 *
 * @module dsh-window/shared/errors
 */

/** 全部面向调用方的稳定错误码（与 REQ §9 表一一对应，双向不得漂移）。 */
export type WindowErrorCode =
  | 'WINDOW_SCENARIO_REQUIRED'
  | 'WINDOW_SEED_REQUIRED'
  | 'WINDOW_OPEN_UNAVAILABLE'
  | 'WINDOW_OPEN_FAILED'
  | 'WINDOW_SEED_DELIVERY_FAILED'
  | 'WINDOW_RUN_STORE_UNAVAILABLE'
  | 'WINDOW_CHILD_BUSY'
  | 'WINDOW_CONFIG_INVALID'
  | 'WINDOW_INVALID_INPUT'
  | 'WINDOW_SEND_FAILED'
  | 'WINDOW_INTERRUPT_FAILED'
  | 'WINDOW_WAIT_UNAVAILABLE'
  | 'WINDOW_OUTPUT_SCHEMA_INVALID'
  | 'WINDOW_STRUCTURED_RESULT_REQUIRED'
  | 'WINDOW_STRUCTURED_RESULT_INVALID'
  | 'WINDOW_RUN_NOT_FOUND'
  | 'WINDOW_RUN_FORBIDDEN'
  | 'WINDOW_RUN_AMBIGUOUS'
  | 'WINDOW_RUN_NOT_ACTIVE'
  | 'WINDOW_RUN_ALREADY_SETTLED'
  | 'WINDOW_RESULT_EMPTY'
  | 'WINDOW_CALLBACK_FAILED'
  | 'WINDOW_CALLBACK_UNKNOWN'
  | 'WINDOW_CALLBACK_NOT_REQUESTED'
  | 'WINDOW_TOPIC_NOT_FOUND'
  | 'WINDOW_TOPIC_STORAGE_UNAVAILABLE'
  | 'WINDOW_TOPIC_FORBIDDEN'
  | 'WINDOW_TOPIC_REVISION_REQUIRED'
  | 'WINDOW_TOPIC_STALE'
  | 'WINDOW_TOPIC_CLAIM_CONFLICT'
  | 'WINDOW_TOPIC_CONFLICT'
  | 'WINDOW_TOPIC_PROJECT_REQUIRED'
  | 'WINDOW_TOPIC_CLAIM_NOT_FOUND'

/** 可被工具层直接透出的结构化错误。 */
export class WindowError extends Error {
  constructor(
    readonly code: WindowErrorCode,
    message: string,
    /** 机器可读的补充读数（如 revision CAS 的 current_revision）；只放非敏感游标。 */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'WindowError'
  }
}

/** 抛出结构化拒绝。 */
export function reject(code: WindowErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new WindowError(code, message, details)
}

/** 把任意抛出值压成可读原因。 */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}
