import { describe, it, expect } from "vitest";
import { parseTargetsCsv } from "../lib/csv";

describe("parseTargetsCsv", () => {
  it("parses a clean file with standard headers", () => {
    const csv = [
      "NMLS,Name,City,State,Annual Volume,Files",
      "123456,Jane Smith,Austin,TX,12500000,40",
      "234567,Bob Jones,Dallas,TX,8000000,25",
    ].join("\n");
    const { rows, warnings } = parseTargetsCsv(csv);
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ nmls: "123456", name: "Jane Smith", city: "Austin", state: "TX", annualVolume: 12500000, annualFiles: 40 });
  });

  it("handles quoted fields containing commas and dollar-formatted volume", () => {
    const csv = [
      "NMLS #,Loan Officer,Total Volume,Units",
      '445566,"Smith, Jane Q.","$12,500,000",40',
    ].join("\r\n");
    const { rows } = parseTargetsCsv(csv);
    expect(rows[0].name).toBe("Smith, Jane Q.");
    expect(rows[0].annualVolume).toBe(12500000);
    expect(rows[0].annualFiles).toBe(40);
    expect(rows[0].nmls).toBe("445566");
  });

  it("accepts header aliases (nmls id / funded volume / loans)", () => {
    const csv = [
      "NMLS ID,Name,Funded Volume,Loans",
      "778899,Ann Lee,20000000,55",
    ].join("\n");
    const { rows } = parseTargetsCsv(csv);
    expect(rows[0].nmls).toBe("778899");
    expect(rows[0].annualVolume).toBe(20000000);
    expect(rows[0].annualFiles).toBe(55);
  });

  it("normalizes NMLS values that include stray formatting", () => {
    const csv = ["NMLS,Name", '"# 123-456",Jane'].join("\n");
    const { rows } = parseTargetsCsv(csv);
    expect(rows[0].nmls).toBe("123456");
  });

  it("skips rows without a valid NMLS and warns per row", () => {
    const csv = [
      "NMLS,Name,Volume",
      ",No NMLS Person,5000000",
      "123456,Valid Person,9000000",
    ].join("\n");
    const { rows, warnings } = parseTargetsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].nmls).toBe("123456");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Row 2");
  });

  it("errors clearly when there is no NMLS column", () => {
    const csv = ["Name,Volume", "Jane,5000000"].join("\n");
    const { rows, warnings } = parseTargetsCsv(csv);
    expect(rows).toEqual([]);
    expect(warnings[0]).toContain("NMLS column");
  });

  it("reports an empty file", () => {
    expect(parseTargetsCsv("").warnings[0]).toContain("empty");
  });
});
