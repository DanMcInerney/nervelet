/** Canonical JSON Schema draft-07; Ajv also validates each environment command. */
export const DIALECT = 'http://json-schema.org/draft-07/schema#';
const text = { type: 'string', minLength: 1, maxLength: 128 };
const waitConditions = [
  { description: 'anyEvent matches any unread retained event, including previously delivered events until seen acknowledges them.',
    type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'anyEvent' } } },
  { description: 'event matches its literal type only after the delivered event floor; "*" is a literal type, not a wildcard.',
    type: 'object', additionalProperties: false, required: ['kind','type'], properties: { kind: { const: 'event' }, type: text } },
  { description: 'jobTerminal matches the named job after it leaves pending, running or stopping.',
    type: 'object', additionalProperties: false, required: ['kind','id'], properties: { kind: { const: 'jobTerminal' }, id: text } },
  { description: 'threshold compares a valid, fresh numeric profile field using gt, gte, lt or lte.',
    type: 'object', additionalProperties: false, required: ['kind','field','op','value'], properties: { kind: { const: 'threshold' }, field: text, op: { enum: ['gt','gte','lt','lte'] }, value: { type: 'number' } } },
  { description: 'change compares a valid, fresh numeric profile field against the initial baseline and deadband.',
    type: 'object', additionalProperties: false, required: ['kind','field','deadband'], properties: { kind: { const: 'change' }, field: text, deadband: { type: 'number', minimum: 0 } } }
];
/** Generated from the same definitions as the public schema. */
export const waitInstructions = 'Wait conditions are an OR-list. ' + waitConditions.map(condition => condition.description).join(' ') +
  ' Empty until adds no event, job or numeric predicate; review deadlines, faults, recovery and lifecycle exits still apply.';
export const waitSchema = {
  type: 'object', additionalProperties: false, required: ['until'],
  properties: {
    reviewMs: { type: 'integer', minimum: 1 },
    until: { type: 'array', maxItems: 8, items: { oneOf: waitConditions } }
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
