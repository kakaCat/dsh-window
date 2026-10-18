/**
 * JSON Schema 校验适配器：把 `@deepseek-ai/dsh-tools` 的强制子集校验包成端口。
 *
 * 应用层不直接 import 宿主包；schema 的合法性校验与结果校验都在这里完成。
 *
 * @module dsh-window/adapters/jsonSchemaGuard
 */
import { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { SchemaGuardPort } from '../application/ports.js'

/** host JSON Schema 校验实现。 */
export class JsonSchemaGuard implements SchemaGuardPort {
  /** 断言 object 根且属于允许子集；非法抛 JsonSchemaError。 */
  assertObjectSchema(raw: unknown): void {
    assertObjectJsonSchema(raw)
  }

  /** 校验值；返回路径化 violations，空数组表示通过。 */
  validate(schema: unknown, value: unknown, path = 'structured'): string[] {
    assertSupportedJsonSchema(schema)
    return validateJsonSchemaValue(schema, value, path)
  }
}
