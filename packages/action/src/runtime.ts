import * as core from "@actions/core";
import type { ActionRuntime } from "./run";

export const runtime: ActionRuntime = {
  getInput: core.getInput,
  setSecret: core.setSecret,
  setOutput: core.setOutput,
  saveState: core.saveState,
  info: core.info,
  notice: core.notice,
  warning: core.warning,
  setFailed: core.setFailed,
  summary: async (markdown) => {
    await core.summary.addRaw(markdown).write();
  },
};
