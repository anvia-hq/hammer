import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { runAction } from "./run";
import { runtime } from "./runtime";

export async function main(): Promise<void> {
  const dispatcher = new EnvHttpProxyAgent();
  setGlobalDispatcher(dispatcher);
  try {
    await runAction(runtime, process.env);
  } finally {
    await dispatcher.close();
  }
}

await main();
