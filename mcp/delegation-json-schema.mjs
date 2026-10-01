// JSON Schema for the two delegation tools' parameters, for hosts without
// TypeBox (the MCP server runs with no npm install). It must stay structurally
// equal to DelegationParametersSchema in extensions/delegation-schema.ts;
// tests/mcp-server.test.mjs compares the two.
export const DELEGATION_PARAMETERS_JSON_SCHEMA = {
  "type": "object",
  "required": [
    "spec"
  ],
  "properties": {
    "spec": {
      "type": "object",
      "required": [
        "version",
        "spec_id",
        "operation",
        "goal",
        "target",
        "requirements",
        "scope",
        "verification"
      ],
      "properties": {
        "version": {
          "type": "number",
          "const": 1
        },
        "spec_id": {
          "type": "string",
          "minLength": 1
        },
        "operation": {
          "type": "string",
          "const": "modify_symbol"
        },
        "goal": {
          "type": "object",
          "required": [
            "summary"
          ],
          "properties": {
            "summary": {
              "type": "string",
              "minLength": 1
            }
          },
          "additionalProperties": false
        },
        "target": {
          "type": "object",
          "required": [
            "file",
            "symbol"
          ],
          "properties": {
            "file": {
              "type": "string",
              "minLength": 1
            },
            "symbol": {
              "type": "string",
              "minLength": 1
            }
          },
          "additionalProperties": false
        },
        "requirements": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "minItems": 1
        },
        "preserve": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "scope": {
          "type": "object",
          "required": [
            "allowed_files",
            "allow_new_files",
            "allow_dependencies",
            "allow_public_api_change"
          ],
          "properties": {
            "allowed_files": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1
              },
              "minItems": 1,
              "maxItems": 2
            },
            "allow_new_files": {
              "type": "boolean"
            },
            "allow_dependencies": {
              "type": "boolean"
            },
            "allow_public_api_change": {
              "type": "boolean"
            }
          },
          "additionalProperties": false
        },
        "verification": {
          "type": "object",
          "properties": {
            "build": {
              "type": "object",
              "required": [
                "project"
              ],
              "properties": {
                "project": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "additionalProperties": false
            },
            "tests": {
              "type": "object",
              "required": [
                "project"
              ],
              "properties": {
                "project": {
                  "type": "string",
                  "minLength": 1
                },
                "names": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    "context": {
      "type": "object",
      "properties": {},
      "additionalProperties": true
    }
  },
  "additionalProperties": false
};
