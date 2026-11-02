import { spawn } from "node:child_process";
import { truncateTail } from "../utils/truncate.ts";

export async function runBash(
  command: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([timeoutSignal, signal])
    : timeoutSignal;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(command, {
      shell: true,
      signal: combinedSignal,
    });

    child.stdout?.on("data", (outChunk) => {
      stdout += outChunk.toString("utf-8");
    });

    child.stderr?.on("data", (errChunk) => {
      stderr += errChunk.toString("utf-8");
    });

    child.on("close", (code) => {
      resolve(
        JSON.stringify({
          stdout: truncateTail(stdout),
          stderr: truncateTail(stderr),
          exitCode: code,
          timedOut: timeoutSignal.aborted,
        }),
      );
    });

    child.on("error", (error) => {
      // 超时引发的 AbortError 属于正常中断流程，等待接下来的 close 事件统一 flush 和 resolve
      if (error.name === "AbortError") {
        return;
      }

      resolve(
        JSON.stringify({
          stdout: truncateTail(stdout),
          stderr: truncateTail(stderr || error.message),
          exitCode: null,
          timedOut: timeoutSignal.aborted,
        }),
      );
    });
  });
}
