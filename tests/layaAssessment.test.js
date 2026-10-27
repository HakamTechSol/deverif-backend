import { describe, it, expect } from "vitest";

import { layaAssessment } from "../src/services/documentService.js";

// layaAssessment is a pure projection over an /ocr/extract result. These tests
// pin its two contracts: it never throws (the advisory feature must not be able
// to fail a verification), and it never hands a caller a risk score to gate on.

const okExtract = (laya) => ({ success: true, data: { document_type: "cnic", fields: {}, laya } });

describe("layaAssessment", () => {
  it("surfaces the one calibrated answer", () => {
    const out = layaAssessment(
      okExtract({
        available: true,
        model: "laya-rl-agent",
        checkpoint: "multilingual",
        elapsed_ms: 2345.1,
        truncated: false,
        answers: {
          document_type: {
            type: "choice",
            value: "cnic",
            probability: 0.998,
            probabilities: { cnic: 0.998, payslip: 0.0, unknown: 0.002 },
            confidence: 0.998,
            advisory_only: false
          },
          document_risk: { type: "choice", value: "low", probability: 0.6713, advisory_only: true },
          is_official_document: { type: "noul", value: true, probability: 0.926, advisory_only: true }
        }
      })
    );

    expect(out).toMatchObject({
      enabled: true,
      checkpoint: "multilingual",
      documentType: "cnic",
      documentTypeProbability: 0.998,
      truncated: false
    });
    expect(out.documentTypeProbabilities.cnic).toBe(0.998);
    expect(out.advisory.riskLabel).toBe("low");
  });

  it("never exports a risk score, only an explicitly untrusted advisory block", () => {
    const out = layaAssessment(
      okExtract({
        available: true,
        answers: {
          document_type: { type: "choice", value: "payslip", probability: 0.99, probabilities: {} },
          document_risk: { type: "choice", value: "low", probability: 0.67, probabilities: {} }
        }
      })
    );

    // A caller must not find a top-level number it could threshold on.
    expect(out.riskScore).toBeUndefined();
    expect(out.advisory.trusted).toBe(false);
    expect(out.advisory.riskProbability).toBe(0.67);
  });

  it("preserves a zero probability rather than dropping it as falsy", () => {
    const out = layaAssessment(
      okExtract({
        available: true,
        answers: {
          document_type: {
            type: "choice",
            value: "cnic",
            probability: 0.998,
            probabilities: { cnic: 0.998, payslip: 0, degree: 0, unknown: 0.002 }
          }
        }
      })
    );
    expect(out.documentTypeProbabilities.payslip).toBe(0);
  });

  it.each([
    ["a missing block", { success: true, data: { document_type: "cnic", fields: {} } }, "not_reported"],
    ["a disabled engine", okExtract({ available: false, reason: "disabled", skipped: true }), "disabled"],
    ["a timeout", okExtract({ available: false, reason: "timeout", timeout_s: 8 }), "timeout"],
    ["a failed load", okExtract({ available: false, reason: "router_unavailable" }), "router_unavailable"],
    ["an available block with no answers", okExtract({ available: true, answers: {} }), "no_document_type"]
  ])("degrades to enabled:false for %s", (_label, extract, reason) => {
    expect(layaAssessment(extract)).toEqual({ enabled: false, reason });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a non-object", 42],
    ["a missing data", { success: true }],
    ["a non-object laya block", { success: true, data: { laya: "nope" } }],
    ["a null answers map", okExtract({ available: true, answers: null })]
  ])("never throws on %s", (_label, extract) => {
    expect(() => layaAssessment(extract)).not.toThrow();
    expect(layaAssessment(extract).enabled).toBe(false);
  });
});