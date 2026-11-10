import { describe, expect, it } from "vitest";
import { fieldError, formErrors } from "@/components/schema-form";
import { blankRow, localIssues, toRows } from "@/components/experiment/model";
import { bytes, duration } from "@/lib/utils";
import type { FormField, Sample } from "@/lib/types";

const f = (o: Partial<FormField>): FormField => ({
  name: "x", type: "string", widget: "text", format: null, description: "", help: "", default: null, enum: null,
  minimum: null, maximum: null, pattern: null, required: false, hidden: false, icon: null, schema: null, mimetype: null, ...o,
});

describe("schema form validation", () => {
  it("enforces required, numeric ranges and enums", () => {
    expect(fieldError(f({ required: true }), "")).toBe("Required");
    expect(fieldError(f({ type: "integer", widget: "number", minimum: 0, maximum: 41 }), 50)).toBe("Maximum 41");
    expect(fieldError(f({ type: "integer", widget: "number" }), 2.5)).toBe("Must be a whole number");
    expect(fieldError(f({ widget: "select", enum: ["star_salmon", "hisat2"] }), "bwa")).toMatch(/One of/);
    expect(fieldError(f({ pattern: "^[^'\"]*$" }), "it's")).toMatch(/Does not match/);
    expect(fieldError(f({ type: "number" }), 3.2)).toBeNull();
  });
  it("skips fields managed by BioCompute", () => {
    const groups = [{ id: "g", title: "g", description: "", icon: null, advanced: false, fields: [f({ name: "input", required: true }), f({ name: "t", required: true })] }];
    expect(Object.keys(formErrors(groups, {}, ["input"]))).toEqual(["t"]);
  });
});

describe("experiment table instant checks", () => {
  const s = (o: Partial<Sample>): Sample => ({ ...blankRow(), ...o });
  it("flags duplicates, bad ids and missing controls", () => {
    const rows = toRows([s({ sample_id: "A" }), s({ sample_id: "A" }), s({ sample_id: "B C" }), s({ sample_id: "D", control_id: "Z" })]);
    const issues = localIssues(rows);
    expect(issues.get(rows[0]._k)?.get("sample_id")?.message).toMatch(/Duplicate/);
    expect(issues.get(rows[2]._k)?.get("sample_id")?.level).toBe("error");
    expect(issues.get(rows[3]._k)?.get("control_id")?.message).toMatch(/not a sample/);
  });
  it("allows repeated ids for technical replicates", () => {
    const rows = toRows([s({ sample_id: "A", technical_replicate: 1 }), s({ sample_id: "A", technical_replicate: 2 })]);
    expect(localIssues(rows).size).toBe(0);
  });
});

describe("formatting", () => {
  it("formats sizes and durations", () => {
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(null)).toBe("—");
    expect(duration("2026-01-01T00:00:00Z", "2026-01-01T01:30:00Z")).toBe("1h 30m");
  });
});
