import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_NAME } from "../src/index";

describe("core", () => {
  it("identifies the workspace package", () => {
    expect(CORE_PACKAGE_NAME).toBe("@anvia/hammer-core");
  });
});
