import { describe, expect, it } from "vitest";
import extension from "../extensions/index.js";
import implementation from "../src/index.js";

describe("Pi package entry", () => {
  it("exports the implementation through the conventional extension path", () => {
    expect(extension).toBe(implementation);
  });
});
