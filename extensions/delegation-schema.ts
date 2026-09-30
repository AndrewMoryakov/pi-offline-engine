// Host-facing TypeBox schemas for the two delegation tools. These describe the
// parameters to Pi and the model; the safety authority remains
// validateImplementationSpec in src/implementation-spec.mjs.
import { Type } from "typebox";

const NonEmptyString = Type.String({ minLength: 1 });

const VerificationSchema = Type.Object({
  build: Type.Optional(Type.Object({
    project: NonEmptyString
  }, { additionalProperties: false })),
  tests: Type.Optional(Type.Object({
    project: NonEmptyString,
    names: Type.Optional(Type.Array(NonEmptyString))
  }, { additionalProperties: false }))
}, { additionalProperties: false });

export const ImplementationSpecSchema = Type.Object({
  version: Type.Literal(1),
  spec_id: NonEmptyString,
  operation: Type.Literal("modify_symbol"),
  goal: Type.Object({
    summary: NonEmptyString
  }, { additionalProperties: false }),
  target: Type.Object({
    file: NonEmptyString,
    symbol: NonEmptyString
  }, { additionalProperties: false }),
  requirements: Type.Array(NonEmptyString, { minItems: 1 }),
  preserve: Type.Optional(Type.Array(NonEmptyString)),
  scope: Type.Object({
    allowed_files: Type.Array(NonEmptyString, { minItems: 1, maxItems: 2 }),
    allow_new_files: Type.Boolean(),
    allow_dependencies: Type.Boolean(),
    allow_public_api_change: Type.Boolean()
  }, { additionalProperties: false }),
  verification: VerificationSchema
}, { additionalProperties: false });

export const DelegationParametersSchema = Type.Object({
  spec: ImplementationSpecSchema,
  context: Type.Optional(Type.Object({}, { additionalProperties: true }))
}, { additionalProperties: false });
