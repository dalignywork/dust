import { describe, expect, it } from "vitest";

import { PROFILE_DIR, wrapCommand } from "../../profile";

describe("wrapCommand", () => {
  it("maps providers to the correct profile wrapper", () => {
    expect(wrapCommand("ls -la", "anthropic")).toBe(
      `source ${PROFILE_DIR}/anthropic.sh && shell "ls -la" 60`
    );
    expect(wrapCommand("pwd", "openai")).toBe(
      `source ${PROFILE_DIR}/openai.sh && shell "pwd" 60`
    );
    expect(wrapCommand("echo hello", "google_ai_studio")).toBe(
      `source ${PROFILE_DIR}/gemini.sh && shell "echo hello" 60`
    );
  });

  it("escapes the command and applies custom timeouts", () => {
    const result = wrapCommand('echo "hello" && echo \\n', "anthropic", {
      timeoutSec: 120,
    });
    expect(result).toBe(
      `source ${PROFILE_DIR}/anthropic.sh && shell "echo \\"hello\\" && echo \\\\n" 120`
    );
  });
});
