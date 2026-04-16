import type { ToolProfile } from "@app/lib/api/sandbox/image/types";
import type { ModelProviderIdType } from "@app/types/assistant/models/types";
import { assertNever } from "@app/types/shared/utils/assert_never";

export const PROFILE_DIR = "/opt/dust/profile";

export interface WrapCommandOptions {
  timeoutSec?: number;
}

export function providerToProfile(
  providerId: ModelProviderIdType
): ToolProfile {
  switch (providerId) {
    case "openai":
      return "openai";
    case "google_ai_studio":
      return "gemini";
    case "anthropic":
    case "mistral":
    case "deepseek":
    case "togetherai":
    case "xai":
    case "fireworks":
    case "noop":
      return "anthropic";
    default:
      assertNever(providerId);
  }
}

export function wrapCommand(
  cmd: string,
  providerId: ModelProviderIdType,
  opts?: WrapCommandOptions
): string {
  const profile = providerToProfile(providerId);
  const timeoutSec = opts?.timeoutSec ?? 60;
  // Escape double quotes and backslashes in command for safe embedding
  const escapedCmd = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `source ${PROFILE_DIR}/${profile}.sh && shell "${escapedCmd}" ${timeoutSec}`;
}

export function wrapCommandWithCapture(
  cmd: string,
  execId: string,
  providerId: ModelProviderIdType,
  opts?: WrapCommandOptions
): string {
  const baseCommand = wrapCommand(cmd, providerId, opts);
  const outFile = `/tmp/dust_exec_${execId}.out`;
  const exitFile = `/tmp/dust_exec_${execId}.exit`;

  return [
    `exec > >(tee ${outFile}) 2>&1`,
    baseCommand,
    `_EXIT=$?`,
    `echo $_EXIT > ${exitFile}`,
    `exit $_EXIT`,
  ].join("\n");
}

export function buildWaitAndCollectCommand(execId: string): string {
  const pidFile = `/tmp/dust_wac_${execId}.pid`;
  const outFile = `/tmp/dust_exec_${execId}.out`;
  const exitFile = `/tmp/dust_exec_${execId}.exit`;

  return [
    `if [ -f ${pidFile} ]; then`,
    `  kill $(cat ${pidFile}) 2>/dev/null`,
    `fi`,
    `echo $$ > ${pidFile}`,
    `while [ ! -f ${exitFile} ]; do sleep 0.5; done`,
    `cat ${outFile}`,
    `exit $(cat ${exitFile})`,
  ].join("\n");
}
