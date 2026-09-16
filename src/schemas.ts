/** Canonical JSON Schema draft-07; Ajv also validates each environment command. */
export const DIALECT = 'http://json-schema.org/draft-07/schema#';
const text = { type: 'string', minLength: 1, maxLength: 128 };
export const waitSchema = {
  type: 'object', additionalProperties: false, required: ['until'],
  properties: {
    reviewMs: { type: 'integer', minimum: 1 },
    until: { type: 'array', maxItems: 8, items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['kind','type'], properties: { kind: { const: 'event' }, type: text } },
      { type: 'object', additionalProperties: false, required: ['kind','id'], properties: { kind: { const: 'jobTerminal' }, id: text } },
      { type: 'object', additionalProperties: false, required: ['kind','field','op','value'], properties: { kind: { const: 'threshold' }, field: text, op: { enum: ['gt','gte','lt','lte'] }, value: { type: 'number' } } },
      { type: 'object', additionalProperties: false, required: ['kind','field','deadband'], properties: { kind: { const: 'change' }, field: text, deadband: { type: 'number', minimum: 0 } } }
    ] } }
  }
};
export const stepSchema = {
  $schema: DIALECT, type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 2 }, loopRef: text, seen: text,
    goalVersion: { type: 'integer', minimum: 0 }, generation: { type: 'integer', minimum: 1 }, waitMs: { type: 'integer', minimum: 0 },
    checkpoint: { type: 'string' }, wait: waitSchema,
    commands: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id','kind','args'],
      properties: { id: { type: 'string', pattern: '^c[1-9][0-9]{0,14}$' }, kind: text, args: { type: 'object' } }
    } }
  }
};
